// Cooperative fiber scheduler backing Halka's concurrency model (#26–#32).
//
// Every evaluator function is a generator, so any expression can suspend.
// `start` spawns a fiber, `await` parks until it finishes, channel and mutex
// operations park on their own queues. A single-threaded round-robin runs
// them; `parallel:` uses the same scheduler but marks the block so a future
// native backend can hand the branches to OS threads.

import { type Fiber, type Suspend, type Channel, type Mutex, type Value, NOTHING, NULL } from "./value.ts";
import { Fiber as FiberClass } from "./value.ts";

export class Deadlock extends Error {
  fibers: Fiber[];
  constructor(fibers: Fiber[]) {
    super("deadlock: every task is blocked");
    this.name = "Deadlock";
    this.fibers = fibers;
  }
}

export class Scheduler {
  private runnable: Fiber[] = [];
  private blocked = new Set<Fiber>();
  private timers: { at: number; fiber: Fiber }[] = [];
  /** Set when a fiber throws, so the driver can surface the first failure. */
  firstError: unknown = null;
  steps = 0;
  /** Safety valve for runaway programs; 0 disables. */
  stepLimit = 0;

  spawn(name: string, gen: Generator<Suspend, Value, unknown>): Fiber {
    const f = new FiberClass(name, gen);
    this.runnable.push(f);
    return f;
  }

  /** Run until `main` finishes; other fibers keep running while work remains. */
  runUntil(main: Fiber): void {
    while (!main.finished) {
      if (!this.tick()) break;
    }
    // Drain anything still runnable so detached tasks and defers complete.
    let guard = 0;
    while (this.runnable.length && guard++ < 1_000_000) this.tick();
  }

  runAll(): void {
    let guard = 0;
    while ((this.runnable.length || this.timers.length) && guard++ < 10_000_000) {
      if (!this.tick()) break;
    }
  }

  /** Advance one fiber. Returns false when nothing can make progress. */
  tick(): boolean {
    if (!this.runnable.length) {
      if (this.timers.length) {
        this.timers.sort((a, b) => a.at - b.at);
        const t = this.timers.shift()!;
        this.unblock(t.fiber, NOTHING);
        return true;
      }
      if (this.blocked.size) throw new Deadlock([...this.blocked]);
      return false;
    }

    const f = this.runnable.shift()!;
    if (f.finished) return true;

    if (f.cancelRequested && f.state !== "running") {
      // The fiber observes cancellation on its next resume via `cancelled`.
    }

    f.state = "running";
    this.steps++;
    if (this.stepLimit && this.steps > this.stepLimit) {
      throw new Error(`step limit exceeded (${this.stepLimit}) — possible infinite loop`);
    }

    let res: IteratorResult<Suspend, Value>;
    try {
      res = f.gen!.next(f.resumeWith);
    } catch (e) {
      f.state = "failed";
      f.error = e;
      f.gen = null;
      if (this.firstError === null) this.firstError = e;
      this.wakeWaiters(f);
      return true;
    }
    f.resumeWith = undefined;

    if (res.done) {
      f.state = f.cancelRequested ? "cancelled" : "done";
      f.result = res.value ?? NOTHING;
      f.gen = null;
      this.wakeWaiters(f);
      return true;
    }

    this.handleSuspend(f, res.value);
    return true;
  }

  private wakeWaiters(f: Fiber): void {
    for (const w of f.waiters) this.unblock(w, f.result);
    f.waiters = [];
  }

  private block(f: Fiber): void {
    f.state = "blocked";
    this.blocked.add(f);
  }

  private unblock(f: Fiber, value: unknown): void {
    if (f.finished) return;
    this.blocked.delete(f);
    f.resumeWith = value;
    f.state = "ready";
    this.runnable.push(f);
  }

  private handleSuspend(f: Fiber, s: Suspend): void {
    switch (s.kind) {
      case "yield":
        f.state = "ready";
        this.runnable.push(f);
        return;

      case "sleep":
        this.block(f);
        this.timers.push({ at: Date.now() + s.ms, fiber: f });
        return;

      case "await": {
        const t = s.task;
        if (t.finished) {
          f.state = "ready";
          f.resumeWith = t;
          this.runnable.push(f);
          return;
        }
        this.block(f);
        t.waiters.push(f);
        return;
      }

      case "send": return this.doSend(f, s.ch, s.value);
      case "recv": return this.doRecv(f, s.ch);
      case "lock": return this.doLock(f, s.m, s.write);
    }
  }

  // ---- channels (#27) ---------------------------------------------------

  private doSend(f: Fiber, ch: Channel, value: Value): void {
    if (ch.closed) {
      f.state = "ready";
      f.resumeWith = { error: "send on a closed channel" };
      this.runnable.push(f);
      return;
    }
    // Hand straight to a waiting receiver.
    const rx = ch.recvQueue.shift();
    if (rx) {
      this.unblock(rx, value);
      f.state = "ready";
      this.runnable.push(f);
      return;
    }
    if (ch.buffer.length < ch.capacity) {
      ch.buffer.push(value);
      f.state = "ready";
      this.runnable.push(f);
      return;
    }
    // Unbuffered or full: park until a receiver arrives.
    this.block(f);
    ch.sendQueue.push({ fiber: f, value });
  }

  private doRecv(f: Fiber, ch: Channel): void {
    if (ch.buffer.length) {
      const v = ch.buffer.shift()!;
      const pending = ch.sendQueue.shift();
      if (pending) {
        ch.buffer.push(pending.value);
        this.unblock(pending.fiber, NOTHING);
      }
      f.state = "ready";
      f.resumeWith = v;
      this.runnable.push(f);
      return;
    }
    const pending = ch.sendQueue.shift();
    if (pending) {
      this.unblock(pending.fiber, NOTHING);
      f.state = "ready";
      f.resumeWith = pending.value;
      this.runnable.push(f);
      return;
    }
    if (ch.closed) {
      f.state = "ready";
      f.resumeWith = NULL;
      this.runnable.push(f);
      return;
    }
    this.block(f);
    ch.recvQueue.push(f);
  }

  closeChannel(ch: Channel): void {
    ch.closed = true;
    for (const rx of ch.recvQueue) this.unblock(rx, NULL);
    ch.recvQueue = [];
    for (const tx of ch.sendQueue) this.unblock(tx, NOTHING);
    ch.sendQueue = [];
  }

  // ---- mutexes (#29) ----------------------------------------------------

  private doLock(f: Fiber, m: Mutex, write: boolean): void {
    const free = write ? !m.locked && m.readers === 0 : !m.locked;
    if (free) {
      if (write) m.locked = true;
      else m.readers++;
      f.state = "ready";
      f.resumeWith = NOTHING;
      this.runnable.push(f);
      return;
    }
    this.block(f);
    m.queue.push({ fiber: f, write });
  }

  unlock(m: Mutex, write: boolean): void {
    if (write) m.locked = false;
    else m.readers = Math.max(0, m.readers - 1);
    // Wake the next compatible waiter.
    for (let i = 0; i < m.queue.length; i++) {
      const w = m.queue[i]!;
      const free = w.write ? !m.locked && m.readers === 0 : !m.locked;
      if (!free) continue;
      m.queue.splice(i, 1);
      if (w.write) m.locked = true;
      else m.readers++;
      this.unblock(w.fiber, NOTHING);
      if (w.write) break;
      i = -1; // readers can all proceed
    }
  }

  // ---- cancellation (#31) ------------------------------------------------

  cancel(f: Fiber): void {
    if (f.finished) return;
    f.cancelRequested = true;
    // A blocked fiber is made runnable so it can observe `cancelled` and clean up.
    if (f.state === "blocked") this.unblock(f, NOTHING);
  }

  get pending(): number { return this.runnable.length + this.blocked.size + this.timers.length; }
}
