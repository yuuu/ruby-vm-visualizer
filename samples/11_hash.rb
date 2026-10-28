# Combining hashes and arrays
scores = { alice: 80, bob: 65, carol: 92 }
scores[:dave] = 70
passed = scores.select { |name, score| score >= 70 }
passed.each do |name, score|
  puts "#{name}: #{score}"
end
p scores.values.sum
