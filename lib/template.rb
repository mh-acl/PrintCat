# template.rb
#
# simple templating in ruby
#
#  	- substitutes keywords from those passed, replacing those in curly brackets
#   - loops over collections when using double curlies
#   - if obj is passed, assume it's an OpenStruct being used as a hash
#
# Example template with looping:
# template =  Template.new(<<-HTML)
# <ol id="{id}">
# 	{items{
# 	<li id="{id}">{value}</a></li>
# 	}}
# </ol>
# HTML
#
# template.fill(
#		id:"my_list",
# 	items:[
# 		{ id:item1, value:"one" },
# 		{ id:item2, value:"two" }
# 	]
# )
# Note: No spaces are allowed between brackets and keys:
# 	{ id } and { items { blah blah } }
# MUST be written as
#   {id} and {items{ blah blah }}
# to function

class Template
	attr_accessor :template
	private :template=

	# the squeeze option removes newlines and any whitespace 
	# at the start of a line
	def initialize(str,squeeze: false)
		str = str.lines.map{|e|e.chomp.lstrip}.join
		parse(str)
	end


	# either pass keyword arguments, a hash, or an object that responds
	# to #to_h, such as OpenStruct. Values must respond to #to_s, and 
	# loopable collections must respond to #each, yielding objects that
	# respond to #to_h. Only one level supported, no nested loops yet.
	def fill(obj=nil,**kwargs)
		data = (obj||kwargs).to_h
		template.map do |part|
			key,prefix,poly = *part
			if poly
				prefix + data[key.to_sym].map{|sdata|
					poly.map{|skey,sprefix|
						sprefix+(
							skey.nil? ? 
							"":
							(sdata[skey.to_sym]||"")
						).to_s
					}.join
				}.join
			else
				prefix+(key.nil? ? "":(data[key.to_sym]||"")).to_s
			end
		end.join
	end

	private def parse(tmpl)
		# break into parts
		self.template = []
		while tmpl =~ /^(?<pre>.*?)(?:\{(?<poly>[^\{\}]+?)\{|\{(?<mono>[^\{\}]+?)\})/
			md = $~
			if md[:mono] # single substitution
				template << [ md[:mono], md[:pre] ] # store name, prefix text
				tmpl = md.post_match
			else # looping
				template << [ md[:poly], md[:pre], []] # name, prefix, subparts
				tmpl = md.post_match
				subparts = template.last.last
				# get rest of subtemplate
				loop do
					tmpl =~ /^(?<pre>.*?)(?:\{(?<poly>[^\{\}]+?)\{|\{(?<mono>[^\{\}]+?)\}|\}\})/
					md = $~
					if md[:mono] # single substitution
						subparts << [ md[:mono], md[:pre] ] # store name, prefix text
						tmpl = md.post_match
					elsif md[:poly] # looping
						raise "nested loops not yet supported"
					else # end of loop section
						subparts << [nil, md[:pre]] # keep the extra bits
						tmpl = md.post_match
						break # exit this loop
					end
				end # loop - extracting subparts
			end
		end # while - matching
		template << [nil, tmpl] # keep the finale bits
	rescue
		p(s:tmpl,md:md)
	end

end






