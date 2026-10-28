module Greet
  def greet = "Hi, #{name}"
end
class Person
  include Greet
  include Comparable
  attr_accessor :name, :age
  @@count = 0
  LIMIT = 3
  def initialize(name, age)
    @name, @age = name, age
    @@count += 1
  end
  def self.count = @@count
  def <=>(o) = age <=> o.age
  def to_s = "#{name}(#{age})"
  def inspect = "#<P #{name}>"
end
a = Person.new("A", 30)
b = Person.new("B", 20)
puts a.greet
p Person.count, a > b, [a, b].min, [a, b].sort.map(&:to_s)
p Person::LIMIT
b.age += 15
puts b
p a.is_a?(Greet), Person.ancestors.first(3)
p a.respond_to?(:greet), a.respond_to?(:nope)
class Person
  def extra = :reopened
end
p a.extra
class Stack
  def initialize; @items = []; end
  def push(x); @items.push(x); self; end
  def pop = @items.pop
  def size = @items.size
  def each(&b) = @items.each(&b)
  include Enumerable
end
s = Stack.new.push(1).push(2).push(3)
p s.map { _1 * 2 }, s.select(&:odd?), s.include?(2), s.sort.reverse
o = Object.new
def o.hello = "singleton"
p o.hello
class Base
  def initialize(x) = @x = x
  def val = @x
end
class Derived < Base
  def initialize(x, y)
    super(x)
    @y = y
  end
  def val = super * 10 + @y
end
p Derived.new(2, 3).val
class Zero < Base
  def initialize(x)
    super
  end
end
p Zero.new(7).val
p Derived.superclass, Derived.name, 1.class, nil.class, :a.class
