class MyError < StandardError
  def initialize(msg = "my default")
    super
  end
end
begin
  raise MyError
rescue => e
  p e.class, e.message
end
begin
  raise MyError, "custom"
rescue MyError, ArgumentError => e
  puts e.message
end
def risky(n)
  raise ArgumentError, "neg" if n < 0
  Math.sqrt(n)
end
[4, -1].each do |n|
  begin
    p risky(n)
  rescue ArgumentError => e
    puts "rescued #{e.message}"
  else
    puts "ok"
  ensure
    puts "ensure #{n}"
  end
end
def retry_it
  tries = 0
  begin
    tries += 1
    raise "fail" if tries < 3
    "succeeded after #{tries}"
  rescue
    retry
  end
end
puts retry_it
x = Integer("zz") rescue "bad"
p x
begin
  nil.upcase
rescue NoMethodError => e
  puts e.class
end
begin
  [1, 2].fetch(10)
rescue IndexError => e
  puts e.class
end
def nested
  yield
rescue => e
  "caught #{e.message} in nested"
end
p nested { raise "inner" }
r = begin
  1 / 0
rescue ZeroDivisionError
  :div
end
p r
raise "final uncaught"
