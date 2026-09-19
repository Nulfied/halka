def sum_to(n):
    total = 0
    for i in range(n):
        total = total + i % 7
    return total
print(f"sum = {sum_to(200000000)}")
