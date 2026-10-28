# Class definitions: defineclass / definemethod and instance variables
class Counter
  def initialize(start)
    @count = start
  end

  def up(step = 1)
    @count += step
    self
  end

  def to_s
    "Counter(#{@count})"
  end
end

c = Counter.new(10)
c.up.up(5)
puts c
