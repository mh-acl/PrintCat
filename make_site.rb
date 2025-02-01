#!/usr/bin/ruby
# create a page for each category and item. 

require 'ostruct'
class String
  def sqz() lines.map(&:strip).join; end
  def tmpl(**kw)
    kw.keys.inject(self){|s,k|s.gsub("{#{k}}",kw[k])}
  end
end

### The HTML Part
html = OpenStruct.new

# category listing
html.catlist_pre = <<-HTML.sqz
    <div class=catlist id="topcat-listing">
HTML
html.catlist_mid = <<-HTML.sqz
      <a class="category" id="{catid}" href="{catpath}" title="{catname}">
        <img src="{catimagepath}">
        <span>{catname}</span>
      </a>
HTML
html.catlist_post = <<-HTML.sqz
    </div>
HTML

# subcategory and item listings
html.subcatlist_wrap_pre = <<-HTML.sqz
    <div id="{catid}-listing">
HTML
html.subcatlist_pre = <<-HTML.sqz
      <div class=subcatlist>
HTML
html.subcatlist_mid = <<-HTML.sqz
        <a class="subcategory" id="{subcatid}" href="{subcatpath}" title="{subcatname}">
          <img src="{subcatimagepath}">
          <span>{subcatname}</span>
        </a>
HTML
html.subcatlist_post = <<-HTML.sqz
      </div>
HTML
html.itemlist_pre = <<-HTML.sqz
      <div class=itemlist>
HTML
html.itemlist_mid = <<-HTML.sqz
        <a class="item" id="{itemid}" href="{itempath}" title="{itemname}">
          <img src="{itemimagepath}">
          <span>{itemname}</span>
        </a>
HTML
html.itemlist_post = <<-HTML.sqz
      </div>
HTML
html.subcatlist_wrap_post = <<-HTML.sqz
    </div>
HTML

# subitem listing
html.subitemlist_pre = <<-HTML.sqz
    <div class=subitemlist id="{itemid}-listing">
HTML
html.subitemlist_mid = <<-HTML.sqz
      <a class="subitem" href="{subitempath}" title="{subitemname}" download="{subitemfilename}">
        <img src="{subitemimagepath}">
        <span>{notes}</span>
      </a>
HTML
html.subitemlist_post = <<-HTML.sqz
    </div>
HTML
html.breadcrumbs_pre = <<-HTML.sqz
  ⬅︎ <a class=breadcrumb href="list.html" name="Top">Top</a> / <wbr>
HTML
html.breadcrumbs = <<-HTML.sqz
  <a class=breadcrumb href="{link}" title="{name}">{name}</a>
HTML
html.breadcrumbs_post = <<-HTML.sqz
  <br>
HTML



# the missing image
nothumb = "nothumb.png"

# find all the print files and sort them
printfiles = Dir.glob('**/*.{b,}gcode').sort

#### top category listing
catpathlist = printfiles.map{|s|s.split("/").first}.uniq
File.open("list.html","w") do |o|
  o.write html.catlist_pre
  # breadcrumbs spacer
  warn html.breadcrumbs_post
  o.write html.breadcrumbs_post

  catpathlist.each do |d|
    catid = d.gsub(/[^[:alnum:]]/,"_")
    catpath = catname = d
    catimagepath = Dir.glob(File.join(d,"thumb.{png,jpg,jpeg}")).first || nothumb
    o.write html.catlist_mid.tmpl(
      catid: catid,
      catpath: catpath+"/list.html",
      catname: catname,
      catimagepath: catimagepath
    )
  end
  o.write html.catlist_end
end



#### other listings


# get subcategories, items, subitems
subcatpathlist = []
itempathlist = []
subitempathlist = []
printfiles.each do |filepath|
  # Split into parts
  *cats,item,file = filepath.split("/")
  # For each subcategory, generate a parent directory path
  cats.inject(){|pth,pt| (subcatpathlist << File.join(pth,pt)).last } if cats.size>=2
  # for items:
  itempathlist << File.join(*cats,item)
  # subitems:
  subitempathlist << filepath
end
subcatpathlist = subcatpathlist.uniq.sort
itempathlist = itempathlist.uniq.sort

### output subcategory/item listings

(catpathlist+subcatpathlist).each do |cp|
  File.open(File.join(cp,"list.html"), "w") do |o|
    # breadcrumbs
    o.write html.breadcrumbs_pre
    crumbs = cp.split("/").inject([]){|a,b|
      [*a,[a.last,b].compact.join("/")]
    }[0...-1].map{|c| [c+"/list.html",c.split("/").last]}
    o.write crumbs.map{|c| html.breadcrumbs.tmpl(link:c[0],name:c[1])}.join(" / ")
    o.write html.breadcrumbs_post

    catid = cp.gsub(/[^[:alnum:]]/,"_")
    o.write html.subcatlist_wrap_pre.tmpl(catid:catid)
    # subcategories for this category if they exist
    scps = subcatpathlist.select{|scp|scp.start_with? cp+"/"}
    o.write html.subcatlist_pre unless scps.empty?
    scps.each do |scp|
      subcatid = scp.gsub(/[^[:alnum:]]/,"_")
      subcatpath = scp
      subcatname = scp.split("/").last
      subcatimagepath = Dir.glob(File.join(scp,"thumb.{png,jpg,jpeg}")).first || nothumb
      o.write html.subcatlist_mid.tmpl(
        subcatid:subcatid,
        subcatpath:subcatpath+"/list.html",
        subcatname:subcatname,
        subcatimagepath:subcatimagepath
      )
    end
    o.write html.subcatlist_post unless scps.empty?
    # items for this category if they exist
    ips = itempathlist.select{|ip| ip.start_with? cp+"/"}
    o.write html.itemlist_pre unless ips.empty?
    ips.each do |ip|
      itemid = ip.gsub(/[^[:alnum:]]/,"_")
      itempath = ip
      itemname = ip.split("/").last[/^(.+?)(?:\s\-\s[\d\()]+)?$/,1]
      itemimagepath = Dir.glob(File.join(ip,"thumb.{png,jpg,jpeg}")).first || nothumb
      o.write html.itemlist_mid.tmpl(
        itemid:itemid,
        itempath:itempath+"/list.html",
        itemname:itemname,
        itemimagepath:itemimagepath
      )
    end
    o.write html.itemlist_post unless ips.empty?
    o.write html.subcatlistwrap_post
  end
end

### output subitem listing
itempathlist.each do |ip|
  File.open(File.join(ip,"list.html"), "w") do |o|
    sips = printfiles.select{|pf| pf.start_with? ip+"/"}
    o.write html.subitemlist_pre
    # breadcrumbs
    o.write html.breadcrumbs_pre
    crumbs = ip.split("/").inject([]){|a,b|
      [*a,[a.last,b].compact.join("/")]
    }[0...-1].map{|c| [c+"/list.html",c.split("/").last]}
    o.write crumbs.map{|c| html.breadcrumbs.tmpl(link:c[0],name:c[1])}.join(" / ")
    o.write html.breadcrumbs_post
    sips.each do |sip|
      subitempath = sip
      subitemfilename = sip.split("/").last
      # get the print info
      gcode_name_parser = /
        ^(?<name>.+?)_
        ((?<nozzle>[\d\.]+)n_)? # optional nozzle size
        (?<layer_height>[\d\.]+mm)_
        (?<material>[^_]+)_
        (?<printer>[^_]+)_
        (?<time>[\dhm]+)\.gcode$
      /x
      matches = subitemfilename.match(gcode_name_parser)

      subitemimagepath = Dir.glob(ip+"/"+matches[:name]+".{png,jpg,jpeg}").first || nothumb

      # try to extract png from gcode
      if subitemimagepath == nothumb
        require 'base64'
        filedata = File.read(sip)[/thumbnail begin.+?\n(.+)thumbnail end/m,1]
        pngdata = Base64.decode64(filedata.gsub(/;\s/,""))
        File.write(ip+"/"+matches[:name]+".png", pngdata)
        subitemimagepath = ip+"/"+matches[:name]+".png"
      end


      notes = [
        matches[:name],
        "<i>Printer:</i> "+matches[:printer]+(matches[:nozzle] ? " #{matches[:nozzle]} nozzle":""),
        "<i>Print time:</i> "+matches[:time]
      ].join("<br>")
      o.write html.subitemlist_mid.tmpl(
        subitempath:subitempath,
        subitemfilename:subitemfilename,
        subitemname:matches[:name],
        subitemimagepath:subitemimagepath,
        notes:notes
      )
    end
    o.write html.subitemlist_post
  end
end