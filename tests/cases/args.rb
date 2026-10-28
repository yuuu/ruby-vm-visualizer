def m(a, b = 2, *rest, c, k: 10, **opts, &blk)
  p [a, b, rest, c, k, opts]
  blk.call(a) if blk
end
m(1, 9)
m(1, 3, 9)
m(1, 3, 4, 5, 9, k: 7, z: 1) { |x| p x * 2 }
def opt(a, b = a * 2, c = b + 1) = [a, b, c]
p opt(1), opt(1, 5), opt(1, 5, 6)
def kw(x:, y: 3) = x + y
p kw(x: 1), kw(y: 1, x: 5)
begin
  kw
rescue ArgumentError => e
  puts e.class
end
def splat(*a) = a
arr = [1, 2]
p splat(*arr, 3), splat(*arr)
a, (b, c), *d = 1, [2, 3], 4, 5
p [a, b, c, d]
x, *y, z = [1, 2, 3, 4]
p [x, y, z]
f, g = 9
p [f, g]
