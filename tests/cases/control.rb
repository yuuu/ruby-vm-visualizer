def classify(x)
  case x
  when 0 then "zero"
  when 1..9 then "small"
  when Integer then "big"
  when "a", "b" then "letter"
  when Array then "array"
  else "other"
  end
end
p [0, 5, 50, "a", [1], :s].map { classify(_1) }
i = 0
out = []
while true
  i += 1
  next if i.odd?
  break if i > 8
  out << i
end
p out
j = 10
j -= 3 until j < 0
p j
r = [1, 2, 3].each do |x|
  begin
    break x if x == 2
  ensure
    out << :ens
  end
end
p r, out
h = {}
h[:a] ||= 1
h[:a] ||= 2
h[:b] = (h[:b] || 0) + 5
p h
a = nil
p a&.length, "xy"&.length
s = +"str"
s << "ing"
s[0] = "S"
p s
x = 5
p(x > 3 ? "yes" : "no")
p (x > 3 and x < 10), (not true)
module Outer
  VAL = 1
  module Inner
    def self.get = VAL + 1
  end
  class K
    def v = VAL
  end
end
p Outer::Inner.get, Outer::K.new.v, Outer::K
class Ghost
  def method_missing(name, *args)
    "ghost #{name} #{args.inspect}"
  end
end
p Ghost.new.boo(1, 2)
class Pt
  attr_reader :x
  def initialize(x) = @x = x
  def ==(o) = o.is_a?(Pt) && x == o.x
end
p Pt.new(1) == Pt.new(1), [Pt.new(2)].include?(Pt.new(2))
@top = 3
@top += 4
p @top
arr = [1, 2, 3]
arr[1] += 10
p arr
def deep(n) = n == 0 ? 0 : 1 + deep(n - 1)
p deep(300)
n = 0
3.times do |a|
  2.times do |b|
    n += a * b
  end
end
p n
words = %w[banana Apple cherry]
p words.sort_by(&:downcase), words.max_by(&:length), words.map.with_index { |w, i| "#{i}#{w}" } rescue p :no_with_index
