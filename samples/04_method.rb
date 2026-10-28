# Method calls: pushed arguments become the callee's local variables
def add(a, b)
  a + b
end

def square(x)
  x * x
end

puts add(square(3), 4)
