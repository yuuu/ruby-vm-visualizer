# Escapes and exceptions specific to YARV
def find_first(list)
  list.each { |x| return x * 10 if x > 1 }
  :none
end
p find_first([1, 2, 3]), find_first([0])

tries = 0
begin
  tries += 1
  raise "again" if tries < 3
  p [:ok, tries]
rescue
  retry
end

r = [1, 2, 3, 4].map do |x|
  begin
    raise "odd" if x.odd?
    x
  rescue
    next -x
  end
end
p r

i = 0
while i < 10
  begin
    i += 1
    raise "stop" if i == 4
  rescue
    break
  end
end
p i

def ens_order
  yield
ensure
  puts "ensure in method"
end
p([1, 2].each { |x| ens_order { break x * 7 } })

def counter
  n = 0
  inc = -> { n += 1 }
  get = proc { n }
  [inc, get]
end
inc, get = counter
inc.call; inc.(); inc[]
p get.call

l = lambda { |a, b = 2| return a + b; 99 }
p l.call(1), l.(1, 5), l.lambda?, l.arity, proc { |x, y| }.arity

class Base
  def greet(name = "you", punct: "!") = "hi #{name}#{punct}"
end
class Kid < Base
  def greet(name = "kid", punct: "?")
    super + " / " + super() + " / " + super("x", punct: ".")
  end
  define_method(:twice) { |v| v * 2 }
  def method_missing(name, *args) = "missing #{name} #{args.inspect}"
  def respond_to_missing?(*) = true
end
k = Kid.new
p k.greet, k.twice(21), k.foo(1, 2)

def kw_only(a:, b: a + 1) = [a, b]
p kw_only(a: 1), kw_only(b: 0, a: 5)
begin
  kw_only
rescue ArgumentError => e
  p e.message
end
begin
  kw_only(a: 1, c: 2)
rescue ArgumentError => e
  p e.message
end

def classify(v)
  case v
  when 1, 2 then :small
  when :sym then :symbol
  when "s" then :string
  when nil then :nil
  else :other
  end
end
p [1, 2, :sym, "s", nil, 3.0, 2.0].map { classify(_1) }

class Pt
  include Comparable
  attr_reader :x
  def initialize(x) = @x = x
  def <=>(o) = x <=> o.x
  def to_s = "Pt(#{x})"
end
puts "#{Pt.new(1)} < #{Pt.new(2)}: #{Pt.new(1) < Pt.new(2)}"
p [Pt.new(3), Pt.new(1)].min.x, Pt.new(2).clamp(Pt.new(0), Pt.new(1)).x

res = catch(:done) do
  10.times { |j| throw :done, j if j == 3 }
  :never
end
p res

e = [1, 2, 3].each
p loop { break 42 }
x = 0
loop do
  x += 1
  raise StopIteration if x > 2
end
p x

def deep_ensure
  begin
    begin
      return :from_inner
    ensure
      puts "inner ensure"
    end
  ensure
    puts "outer ensure"
  end
end
p deep_ensure

a, (b, *c), d = 1, [2, 3, 4], 5
p [a, b, c, d]
h = { a: 1 }
h[:b] ||= 2
h[:a] &&= 10
p h, h&.size, nil&.size
s = +"ab"
s << "cd"
p s, s.frozen?, "lit".frozen?, :sym.to_proc.call("x") rescue p $!.class
p defined?(foo), defined?(p), defined?(String), defined?(@zz), defined?(yield)
$stdout_check = __method__.inspect
p $stdout_check
p 2**10, 7.fdiv(2), -7 / 2, -7 % 3, 10.divmod(3), 1_000_000.to_s.size
