# Exceptions: find the rescue clause via the catch table
def divide(a, b)
  a / b
rescue ZeroDivisionError => e
  puts "error: #{e.message}"
  0
ensure
  puts "divide done"
end

puts divide(10, 2)
puts divide(1, 0)
