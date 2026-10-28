# break and ensure: the throw instruction escapes across frames
result = [10, 20, 30].each do |x|
  begin
    break x * 2 if x == 20
  ensure
    puts "ensure (x = #{x})"
  end
end
p result
