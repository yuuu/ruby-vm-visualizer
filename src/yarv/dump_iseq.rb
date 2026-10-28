# Compiles Ruby source into a YARV instruction sequence and turns it into JSON the visualizer can read.
# Used both by ruby.wasm in the browser and by the local ruby for building samples and running tests.
# ruby.wasm does not ship the json library, so the JSON is written by hand.
#
#   IseqDump.dump(source) #=> JSON string
module IseqDump
  # Positions of operands that take a branch target (OFFSET)
  OFFSET_OPERANDS = {
    jump: [0], branchif: [0], branchunless: [0], branchnil: [0],
    opt_case_dispatch: [1], opt_new: [1],
  }.freeze

  # Positions of operands that take a CALL_DATA
  CALLDATA_OPERANDS = Hash.new([0]).merge(
    opt_ary_freeze: [1], opt_hash_freeze: [1], opt_str_freeze: [1], opt_str_uminus: [1],
    opt_neq: [0, 1],
  ).freeze
  CALLDATA_INSNS = %i[
    send sendforward opt_send_without_block opt_new objtostring opt_ary_freeze opt_hash_freeze
    opt_str_freeze opt_nil_p opt_str_uminus invokesuper invokesuperforward invokeblock
    opt_plus opt_minus opt_mult opt_div opt_mod opt_eq opt_neq opt_lt opt_le opt_gt opt_ge
    opt_ltlt opt_and opt_or opt_aref opt_aset opt_length opt_size opt_empty_p opt_succ opt_not
    opt_regexpmatch2
  ].freeze

  def self.dump(source, path = "main.rb")
    iseq = RubyVM::InstructionSequence.compile(source, path, path, 1)
    new_dumper.run(iseq)
  rescue SyntaxError => e
    json({ "error" => e.message })
  end

  def self.new_dumper
    Dumper.new
  end

  class Dumper
    def initialize
      @iseqs = []
      # In to_a, the same iseq (e.g. a block) appears as separate arrays in both the send operand and the catch table,
      # so iseqs with the same contents share one index
      @seen = {}
    end

    def run(iseq)
      walk(iseq.to_a, nil)
      IseqDump.json({
        "ruby" => RUBY_VERSION,
        "description" => RUBY_DESCRIPTION,
        "iseqs" => @iseqs,
      })
    end

    private

    def label_name(s)
      s.gsub("<compiled>", "<main>")
    end

    def walk(a, parent)
      return @seen[a] if @seen.key?(a)
      index = @iseqs.size
      @seen[a] = index
      @iseqs << nil
      _magic, _major, _minor, _fmt, misc, label, _path, _abs, first_line, type, locals, params, catch_table, body = a

      # Pass 1: find the position (instruction address) of each label
      labels = {}
      pc = 0
      body.each do |e|
        case e
        when Symbol then labels[e] = pc if e.to_s.start_with?("label_")
        when Array then pc += e.size
        end
      end

      # Pass 2: collect the line number, events, and operands of each instruction
      insns = []
      pc = 0
      line = first_line
      events = []
      body.each do |e|
        case e
        when Integer
          line = e
        when Symbol
          events << e.to_s.sub("RUBY_EVENT_", "") if e.to_s.start_with?("RUBY_EVENT_")
        when Array
          name = e[0]
          ops = e[1..].each_with_index.map { |o, i| operand(name, i, o, labels, index) }
          insns << { "pc" => pc, "name" => name.to_s, "ops" => ops, "line" => line, "events" => events }
          events = []
          pc += e.size
        end
      end

      catches = catch_table.map do |type_, ciseq, st, ed, cont, sp|
        {
          "type" => type_.to_s,
          "iseq" => ciseq ? walk(ciseq, index) : nil,
          "start" => labels.fetch(st), "end" => labels.fetch(ed), "cont" => labels.fetch(cont), "sp" => sp,
        }
      end

      prm = {}
      params.each do |k, v|
        prm[k.to_s] =
          case k
          when :opt then v.map { |l| labels.fetch(l) }
          when :keyword then v.map { |kw| kw.is_a?(Array) ? { "name" => kw[0].to_s, "default" => (kw.size > 1 ? value(kw[1], index) : nil), "required" => false, "static" => kw.size > 1 } : { "name" => kw.to_s, "required" => true } }
          else v
          end
      end

      @iseqs[index] = {
        "index" => index,
        "type" => type.to_s,
        "label" => label_name(label),
        "parent" => parent,
        "firstLine" => first_line,
        "localTable" => locals.map { |l| l.is_a?(Symbol) ? l.to_s : "?" },
        "localSize" => misc[:local_size],
        "argSize" => misc[:arg_size],
        "stackMax" => misc[:stack_max],
        "codeLocation" => misc[:code_location],
        "params" => prm,
        "catchTable" => catches,
        "insns" => insns,
        "size" => pc,
      }
      index
    end

    def operand(name, i, o, labels, index)
      if OFFSET_OPERANDS[name]&.include?(i)
        return { "t" => "label", "pc" => labels.fetch(o) }
      end
      if name == :opt_case_dispatch && i == 0
        return { "t" => "cdhash", "v" => o.each_slice(2).map { |k, l| [value(k, index), labels.fetch(l)] } }
      end
      if CALLDATA_INSNS.include?(name) && CALLDATA_OPERANDS[name].include?(i) && o.is_a?(Hash)
        cd = { "t" => "cd", "mid" => o[:mid]&.to_s, "flag" => o[:flag], "argc" => o[:orig_argc] }
        cd["kw"] = o[:kw_arg].map(&:to_s) if o[:kw_arg]
        return cd
      end
      value(o, index)
    end

    def value(v, index)
      case v
      when nil then { "t" => "nil" }
      when true then { "t" => "true" }
      when false then { "t" => "false" }
      when Integer then { "t" => "int", "v" => v.to_s }
      when Float
        { "t" => "float", "v" => v.nan? ? "NaN" : v.infinite? ? (v > 0 ? "Infinity" : "-Infinity") : v.to_s }
      when Symbol then { "t" => "sym", "v" => v.to_s }
      when String then { "t" => "str", "v" => v.dup.force_encoding(Encoding::UTF_8).scrub }
      when Range then { "t" => "range", "b" => value(v.begin, index), "e" => value(v.end, index), "excl" => v.exclude_end? }
      when Regexp then { "t" => "regexp", "v" => v.source, "o" => v.options }
      when Module then { "t" => "const", "v" => v.name.to_s }
      when Hash then { "t" => "hash", "v" => v.map { |k, x| [value(k, index), value(x, index)] } }
      when Array
        if v[0] == "YARVInstructionSequence/SimpleDataFormat"
          { "t" => "iseq", "i" => walk(v, index) }
        else
          { "t" => "array", "v" => v.map { |x| value(x, index) } }
        end
      else
        { "t" => "other", "v" => v.inspect }
      end
    end
  end

  def self.json(v)
    case v
    when nil then "null"
    when true then "true"
    when false then "false"
    when Integer then v.to_s
    when Float then v.finite? ? v.to_s : "null"
    when String then json_string(v)
    when Symbol then json_string(v.to_s)
    when Array then "[" + v.map { |x| json(x) }.join(",") + "]"
    when Hash then "{" + v.map { |k, x| json_string(k.to_s) + ":" + json(x) }.join(",") + "}"
    else json_string(v.to_s)
    end
  end

  def self.json_string(s)
    s = s.dup.force_encoding(Encoding::UTF_8).scrub
    '"' + s.gsub(/["\\\u0000-\u001f  ]/) { |c|
      case c
      when '"' then '\\"'
      when "\\" then "\\\\"
      when "\n" then "\\n"
      when "\t" then "\\t"
      when "\r" then "\\r"
      else format("\\u%04x", c.ord)
      end
    } + '"'
  end
end
