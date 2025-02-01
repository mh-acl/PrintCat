

class HTML5
  EMPTY = %w{area base br col embed hr img input link meta param 
    source track wbr}
  def initialize()

  end

  def _fix(str) str.to_s.gsub( "_", "-" ) end
  def _esc(str) str.to_s.gsub( /"/, '\"') end

  def method_missing(name,*args,**attrs,&block)
    a = [name.to_s,*attrs.keys.map{|k|%'#{_fix(k)}="#{_esc(attr[k])}"'}].join(" ")

    if EMPTY.include? name.to_s
      "<#{a}>"
    elsif name.to_s == "html"
      "<!doctype html><#{a}>#{block&.call:''}</#{a}>"
    else
      "<#{a}>#{block&.call}</#{a}>"
    end
  end
end