# yield: call a block from your own method with invokeblock
def twice
  yield 1
  yield 2
end

twice { |n| puts n * 100 }

def find_first(list)
  list.each do |x|
    return x if x > 2
  end
  nil
end
p find_first([1, 2, 3, 4])
