r = [1, 2, 3, 4].each { |x| break x * 10 if x == 3 }
p r
p [1, 2, 3].map { |x| next 0 if x == 2; x }
def it
  yield 1, 2
end
it { |a, b| p [a, b] }
it { |a| p a }
p [[1, 2], [3, 4]].map { |a, b| a + b }
counter = 0
inc = -> { counter += 1 }
3.times { inc.call }
p counter
add = lambda { |a, b| a + b }
p add.(1, 2), add[3, 4]
sq = proc { |x| x * x }
p [1, 2, 3].map(&sq)
p %w[a b c].map(&:upcase)
def blk(&b) = b
b = blk { |x| x + 1 }
p b.call(1)
def gen
  return 5 unless block_given?
  yield
end
p gen, gen { 6 }
p (1..10).select(&:even?).inject(:+)
p [3, 1, 2].sort_by { -_1 }
p [1, 2, 3].each_with_index.map { |x, i| x * i }
h = Hash.new { |hash, k| hash[k] = k * 2 }
p h[4], h
p [1,2,3].inject { |s, x| s * x }
p (1..3).each_with_object([]) { |x, acc| acc << x * 3 }
y = 10
[1].each { |y2| y += y2 }
p y
def ret_from_proc
  [1, 2, 3].each { |x| return x * 100 if x == 2 }
  :none
end
p ret_from_proc
x = loop do
  break 42
end
p x
i = 0
loop do
  i += 1
  raise StopIteration if i > 3
end
p i
