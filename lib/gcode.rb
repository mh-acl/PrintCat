# gcode.rb
#
# Parses PrusaSlicer gcode files to get some basic info from them



class Gcode
	attr_accessor :path, :values
	private :path=, :values=, :values

	def initialize(path)
		self.path = path
	end

	def inspect
		"#{self.class}(#{path})"
	end

	def [](key)
		if values.nil?
			self.values = {}
			fetch_values
		end
		values[key.to_s]
	end

	# fetch all the keys
	private def fetch_values
		File.open(path,'r') do |g|
			until g.eof?
				line = g.readline

				# thumbnail needs special parsing
				if line =~ /thumbnail begin/
					data = "" # container for base64 data
					loop do
						line = g.readline
						if line =~ /thumbnail end/ # no more data
							break
						else
							data << line[%r{[a-zA-Z0-9/+=]+}] # get base64 part of line
						end
					end
					require 'base64'
					values['thumbnail'] = Base64.decode64(data)
				end

				# if there's a key/value pair, extract it
				if line =~ /^; (.+) = ([^\n]+)$/
					values[$1] = $2 # captured key/value from prev line
				end

			end # until g.eof?
		end # close file
	end
end