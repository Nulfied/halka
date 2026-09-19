import zipfile, sys, io
from xml.etree import ElementTree as ET
W='{http://schemas.openxmlformats.org/wordprocessingml/2006/main}'

def runs_text(p):
    out=[]
    for node in p.iter():
        t=node.tag
        if t==W+'t': out.append(node.text or '')
        elif t==W+'br': out.append('\n')
        elif t==W+'tab': out.append('    ')
    return ''.join(out)

def style(p):
    pPr=p.find(W+'pPr')
    if pPr is None: return None
    s=pPr.find(W+'pStyle')
    return s.get(W+'val') if s is not None else None

def convert(path):
    z=zipfile.ZipFile(path)
    x=ET.fromstring(z.read('word/document.xml'))
    body=x.find(W+'body')
    out=[]; code=[]
    def flush():
        nonlocal code
        if code:
            while code and not code[-1].strip(): code.pop()
            out.append('```halka\n'+'\n'.join(code)+'\n```\n')
            code=[]
    for el in body:
        if el.tag==W+'p':
            st=style(el); txt=runs_text(el)
            if st=='Code':
                code.extend(txt.split('\n')); continue
            flush()
            t=txt.strip()
            if not t: continue
            t=t.replace('\u201c','`').replace('\u201d','`')
            if st=='Heading1': out.append('\n## '+t.replace('\U0001f512','').strip()+'\n')
            elif st=='ListBullet': out.append('- '+t)
            else:
                if t.startswith('LOCKED RULE'): out.append('\n> **'+t+'**\n')
                else: out.append('\n'+t+'\n')
        elif el.tag==W+'tbl':
            flush(); rows=[]
            for tr in el.iter(W+'tr'):
                rows.append([' '.join(runs_text(p).strip() for p in tc.iter(W+'p')).strip() for tc in tr.findall(W+'tc')])
            if rows:
                out.append('\n| '+' | '.join(rows[0])+' |')
                out.append('|'+'|'.join(['---']*len(rows[0]))+'|')
                for r in rows[1:]: out.append('| '+' | '.join(r)+' |')
                out.append('')
    flush()
    return '\n'.join(out)

parts=[convert(p) for p in sys.argv[1:]]
sys.stdout.write('\n'.join(parts))
