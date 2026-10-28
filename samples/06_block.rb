# Blocks: read and write the outer variable with getlocal_WC_1
sum = 0
[1, 2, 3].each do |x|
  sum += x * 10
end
puts sum

squares = (1..4).map { |n| n * n }
p squares
