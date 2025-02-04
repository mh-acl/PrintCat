#!/usr/bin/ruby
# create a page for each category and item. 

require 'ostruct'
require './lib/template'
class String
  def sqz() lines.map(&:strip).join; end
  def tmpl(**kw)
    kw.keys.inject(self){|s,k|s.gsub("{#{k}}",kw[k])}
  end
end

### The HTML Part
html = OpenStruct.new

# category listing
html.catlist = Template.new(<<-HTML, squeeze: true)
    <div class=catlist id="topcat-listing">
      <br><!-- breadcrumb space-->
      {cats{
      <a class="category" id="{catid}" href="{catpath}" title="{catname}">
        <img src="{catimagepath}">
        <span>{catname}</span>
      </a>
      }}
    </div>
HTML

# crumbs:
# ⬅︎ <a class=breadcrumb href="list.html" name="Top">Top</a>
# {crumbs{
# &nbsp;/ <a class=breadcrumb href="{link}" title="{name}">{name}</a>
# }}

# NEW subcategory and item listings
html.catlist = Template.new(<<-HTML,squeeze:true)
    <div id="{id}-listing">
      {crumbs{<a class=breadcrumb href="{link}" title="{name}">{name}</a> }}
      <br><!-- end breadcrumbs -->
      <div class=subcatlist>
        {subcats{
        <a class="subcategory" id="{id}" href="{path}" title="{name}">
          <img src="{imagepath}">
          <span>{name}</span>
        </a>
        }}
      </div>
      <div class=itemlist>
        {items{
        <a class="item" id="{id}" href="{path}" title="{name}">
          <img src="{imagepath}">
          <span>{name}</span>
        </a>
        }}
      </div>
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

# NEW subitem listing
html.subitemlist = Template.new(<<-HTML,squeeze:true)
    <div class=subitemlist id="{itemid}-listing">
      {crumbs{<a class=breadcrumb href="{link}" title="{name}">{name}</a> }}
      <br><!-- end breadcrumbs -->
      {subitems{
      <a class="subitem" href="{path}" title="{name}" download="{filename}">
        <img src="{imagepath}">
        <span>{notes}</span>
      </a>
    }}
    </div>
HTML


# NEW subitem listing


# the missing image
nothumb = "nothumb.png"

# convert to id
id=->(str){str ? str.gsub(/[^[:alnum:]]/,"_"):"all"}
apath=->(path){path.split("/")}
spath=->(path){path.join("/")}
idx_for=->(dir){dir ? spath[[*apath[dir],"list.html"]]:"listall.html"}

# find all the print files and sort them
printfiles = Dir.glob('**/*.{b,}gcode').sort

# get all the listings
topcatpaths = []
subcatpaths = []
catpaths    = [] # in case it makes no sense to differentiate between top categories and subcats
itempaths   = []
printfiles.each do |path|
  # split filename into parts
  *cats,item,file = path.split("/")
  # top categories:
  topcatpaths<<cats.first
  # subcategories: add each parent category 
  cats.inject{ |parent,child| (subcatpaths<<(parent+"/"+child)).last }
  # catpaths (experimental):
  cats.inject(nil){ |parent,child| (catpaths<<[parent,child].compact.join("/")).last }
  # itempaths:
  itempaths<<[*cats,item].join("/")
end
catpaths.uniq!
itempaths.uniq!
warn subcatpaths.inspect


def pp(val) p(val); val; end


#### other listings

### new category and item listing
# "" => top level
# nil => list all
["",nil,*catpaths].each do |cp|
  File.open(idx_for[cp],'w') do |idx|
    idx.write html.catlist.fill(
      id: id[cp],
      crumbs: (apath[cp||" "].size).times.map do |n|
        { link: idx_for[spath[apath[cp||" "].first(n)]],
          name: n>0 ? apath[cp||" "][n-1] : "Top"
        }
      end,
      subcats: catpaths.select{|x|cp ? apath[x][0...-1]==apath[cp]:false}.map do |x|
        { id: x.gsub(/[^[:alnum:]]/,"_"),
          path: idx_for[x],
          name: x.split("/").last,
          imagepath: Dir.glob(File.join(x,"thumb.{png,jpg,jpeg}")).first || nothumb
        }
      end + (cp&.empty? ?
        [{id: "all",
          path: "listall.html",
          name: "All Items",
          imagepath: nothumb
        }]
        : []
      ),
      items: itempaths.select{|x|cp ? apath[x][0...-1]==apath[cp]:true}.map do |x|
        { id: x.gsub(/[^[:alnum:]]/,"_"),
          path: idx_for[x],
          name: x.split("/").last[/^(.+?)(?:\s\-\s[\d\()]+)?$/,1],
          imagepath: Dir.glob(File.join(x,"thumb.{png,jpg,jpeg}")).first || nothumb
        }
      end
    ) # template
  end
end

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

# (catpathlist+subcatpathlist).map do |cp|
#   File.open(File.join(cp,"olist.html"), "w") do |o|
#     # breadcrumbs
#     o.write html.breadcrumbs_pre
#     crumbs = cp.split("/").inject([]){|a,b|
#       [*a,[a.last,b].compact.join("/")]
#     }[0...-1].map{|c| [c+"/list.html",c.split("/").last]}
#     o.write crumbs.map{|c| html.breadcrumbs.tmpl(link:c[0],name:c[1])}.join(" / ")
#     o.write html.breadcrumbs_post

#     catid = cp.gsub(/[^[:alnum:]]/,"_")
#     o.write html.subcatlist_wrap_pre.tmpl(catid:catid)
#     # subcategories for this category if they exist
#     scps = subcatpathlist.select{|scp|scp.start_with? cp+"/"}
#     o.write html.subcatlist_pre unless scps.empty?
#     scps.each do |scp|
#       subcatid = scp.gsub(/[^[:alnum:]]/,"_")
#       subcatpath = scp
#       subcatname = scp.split("/").last
#       subcatimagepath = Dir.glob(File.join(scp,"thumb.{png,jpg,jpeg}")).first || nothumb
#       o.write html.subcatlist_mid.tmpl(
#         subcatid:subcatid,
#         subcatpath:subcatpath+"/list.html",
#         subcatname:subcatname,
#         subcatimagepath:subcatimagepath
#       )
#     end
#     o.write html.subcatlist_post unless scps.empty?

#     # items for this category if they exist
#     ips = itempathlist.select{|ip| ip.start_with? cp+"/"}
#     o.write html.itemlist_pre unless ips.empty?
#     ips.each do |ip|
#       itemid = ip.gsub(/[^[:alnum:]]/,"_")
#       itempath = ip
#       itemname = ip.split("/").last[/^(.+?)(?:\s\-\s[\d\()]+)?$/,1]
#       itemimagepath = Dir.glob(File.join(ip,"thumb.{png,jpg,jpeg}")).first || nothumb
#       o.write html.itemlist_mid.tmpl(
#         itemid:itemid,
#         itempath:itempath+"/list.html",
#         itemname:itemname,
#         itemimagepath:itemimagepath
#       )
#     end
#     o.write html.itemlist_post unless ips.empty?
#     o.write html.subcatlistwrap_post
#   end
# end

### output "all items" listing
# File.open("biglist.html",'w') do |o|
#   o.write html.itemlist_pre
#   # breadcrumbs: just the top level
#   o.write html.breadcrumbs_pre
#   o.write html.breadcrumbs_post

#   #warn itempathlist.inspect

#   itempathlist.each do |ip|
#     itemid = ip.gsub(/[^[:alnum:]]/,"_")
#     itempath = ip
#     itemname = ip.split("/").last[/^(.+?)(?:\s\-\s[\d\()]+)?$/,1]
#     itemimagepath = Dir.glob(File.join(ip,"thumb.{png,jpg,jpeg}")).first || nothumb
#     o.write html.itemlist_mid.tmpl(
#       itemid:itemid,
#       itempath:itempath+"/list.html",
#       itemname:itemname,
#       itemimagepath:itemimagepath
#     )
#   end
#   o.write html.itemlist_post
# end

### new subitem listing
itempaths.each do |ip|
  File.open(idx_for[ip],'w') do |idx|
    idx.write html.subitemlist.fill(
      id: id[ip],
      crumbs: (apath[ip].size).times.map do |n|
        { link: idx_for[spath[apath[ip].first(n)]],
          name: n>0 ? apath[ip][n-1] : "Top"
        }
      end,
      subitems: printfiles.select{|x|apath[x][0...-1]==apath[ip]}.map do |x|
        matches = apath[x].last.match(/
          ^(?<name>.+?)_
          ((?<nozzle>[\d\.]+)n_)? # optional nozzle size
          (?<layer_height>[\d\.]+mm)_
          (?<material>[^_]+)_
          (?<printer>[^_]+)_
          (?<time>[\dhm]+)\.gcode$
        /x)
        if Dir.glob(ip+"/"+matches[:name]+".{jpg,jpeg,png}").empty?
          require './lib/gcode'
          File.write(ip+"/"+matches[:name]+".png",Gcode.new(x)[:thumbnail])
        end
        { path: x,
          name: matches[:name],
          filename: apath[x].last,
          imagepath: Dir.glob(ip+"/"+matches[:name]+".{jpg,jpeg,png}").first || nothumb,
          notes:[
            matches[:name],
            "<i>Printer:</i> "+matches[:printer]+(matches[:nozzle] ? " #{matches[:nozzle]} nozzle":""),
            "<i>Print time:</i> "+matches[:time]
          ].join("<br>")
        }
      end
    )
  end
end
