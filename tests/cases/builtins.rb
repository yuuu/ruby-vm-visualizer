p 7 / 2, -7 / 2, 7 % 3, -7 % 3, 2 ** 10, 2 ** 70, 7.0 / 2, 10.fdiv(4)
p 1.5.round, 2.5.round, 3.14159.round(2), 10.divmod(3), 255.to_s(16), "ff".to_i(16)
p 0.1 + 0.2, 1e20, 1.0e-5, 100.0, 3.7.floor, 3.2.ceil, -3.7.truncate
p 10.gcd(4), 10.lcm(4), 5.between?(1, 10), 15.clamp(1, 10)
p "hello world".split, "a,b,,c".split(","), "abc".reverse, "abc" * 2, "Ruby".center(10, "*")
p "hello"[1], "hello"[1, 3], "hello"[1..], "hello"[-3..], "ab".succ, "az".succ, "zz".succ
p "Hello".start_with?("He"), "x-y-z".tr("-", "_"), "aaa".sub("a", "b"), "aaa".gsub("a", "b")
p "%05.2f|%-4s|%+d|%x" % [3.14159, "ab", 5, 255], format("%03d", 7)
p [3, 1, 2].sort, [3, 1, 2].max, [1, 2, 3, 4].partition(&:even?), [1, 2, 3].zip([4, 5, 6])
p [1, [2, [3, [4]]]].flatten, [1, nil, 2].compact, [1, 1, 2].uniq, [1, 2, 3, 4].each_slice(2).to_a
p (1...5).to_a, ("a".."e").to_a, (1..4).sum, (1..4).reduce(:*)
p [1, 2, 3].sum { _1 * 2 }, %w[apple pie a].group_by(&:size), %w[a b a].tally
p({ a: 1 }.merge({ b: 2 }), { a: 1, b: 2 }.map { |k, v| [k, v * 2] }.to_h, { a: 1 }.to_a)
h = { "x" => 1, y: [1, 2], 3 => nil }
p h, h.keys, h.key?(:y), h.fetch("x"), h.dig(:y, 0)
p [1, 2, 3].first(2), [1, 2, 3].last(2), [5, 3, 9].min_by { -_1 }, [1, 2, 3, 4].take_while { _1 < 3 }
a = [1, 2, 3]
a << 4
a.push(5, 6)
a.unshift(0)
p a, a.pop, a.shift, a.length, a.include?(3), a.index(3), a.join("-")
p :upcase.to_proc.call("str"), nil.to_a, nil.to_s, 1.zero?, 0.zero?
puts [1, [2, [nil, 3]]], nil
print "a", "b", 1, "\n"
p 1 == 1.0, 1.eql?(1.0), "a" == "a", [1, 2] == [1, 2], { a: 1 } == { a: 1 }
p 10.times.map { _1 * _1 }.select(&:even?)
$glob = 5
def read_glob = $glob + 1
p read_glob
CONST_A = [1, 2].freeze
p CONST_A.frozen?
p 3.times.to_a, 1.upto(4).to_a, 4.downto(1).to_a
p "abc".each_char.to_a rescue p $!
