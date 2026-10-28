# Closures: the environment captured by a Proc moves from the stack to the heap
def make_counter
  count = 0
  -> { count += 1 }
end

counter = make_counter
counter.call
counter.call
p counter.call
