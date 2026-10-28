# Inheritance and super
class Animal
  def initialize(name)
    @name = name
  end

  def speak
    "#{@name} makes a sound"
  end
end

class Dog < Animal
  def speak
    super + " (Woof!)"
  end
end

animals = [Animal.new("Cat"), Dog.new("Pochi")]
animals.each { |a| puts a.speak }
