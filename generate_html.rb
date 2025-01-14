#!/usr/bin/ruby
#
# generate_html.rb
# 
# create an html page for browsing the print catalog

# switch to the passed directory, otherwise just use the working directory
Dir.chdir(ARGV[0]) if ARGV[0]

# open index.html for writing
out = File.open('index.html','w')

parts = {
	page_start: 
'<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Print Catalog</title>
  <style type="text/css">
    i.icon
  </style>
</head>
<body>
<h1>Member Print Catalog</h1>
<figure class=categorylist>
  <figcaption>Categories</figcaption>
  <ul>
',	category_start: 
'    <li><figure class=category>
      <figcaption>{categoryname}</figcaption>
      <img src={categoryimg}>
      <ul>
',	item_start:
'        <li><figure class=item>
          <figcaption>{itemname}</figcaption>
          <img src={itemimg}>
          <ul>
',  subitem:
'            <li><figure class=subitem>
              <figcaption>{description}</figcaption>
              <img src="{subitemimg}">
              <a href="{filelink}" type="application/octet-stream" download="{filename}">⤓</a>
            </figure></li>
',  item_end:
'          </ul>
        </figure></li>
',
	category_end:
'      </ul>
    </figure></li>
',
	page_end:
'  </ul>
</figure>
</body>
</html>'
}

# placeholder image
phiuri = 'data:image/svg+xml,%3Csvg%20xmlns%3D%22http%3A%2F%2Fwww.w3.org%2F2000%2Fsvg%22%20width%3D%22265%22%20height%3D%22265%22%20fill-rule%3D%22evenodd%22%3E%3Cpath%20d%3D%22M238.369%20132.5c0-58.47-47.399-105.869-105.869-105.869a105.42%20105.42%200%200%200-67.175%2024.04l149.366%20148.554c14.802-18.209%2023.678-41.429%2023.678-66.725zM50.309%2065.775c-14.801%2018.21-23.678%2041.429-23.678%2066.725%200%2058.47%2047.399%20105.869%20105.869%20105.869%2025.503%200%2048.899-9.019%2067.175-24.04zM265%20132.5C265%2059.322%20205.678%200%20132.5%200S0%2059.322%200%20132.5%2059.322%20265%20132.5%20265%20265%20205.678%20265%20132.5%22%20fill%3D%22%23f33%22%2F%3E%3C%2Fsvg%3E'

gcode_name_parser = /
  ^(?<name>.+?)_
  ((?<nozzle>[\d\.]+n)_)? # optional nozzle size
  (?<layer_height>[\d\.]+mm)_
  (?<material>[^_]+)_
  (?<printer>[^_]+)_
  (?<time>[\dhm]+)\.gcode$
/x

item_name_parser = /^(.+?)(?:\s+\-\s[\d\(\)]+)?$/

out.print parts[:page_start]
categories = Dir.entries(Dir.pwd).select do |dir| # select actual subdirectories
  File.directory?(dir) && # must be directory and
  !dir[/^\.\.?$/]         # not the . or .. directories
end

### Category list
categories.each do |category_dir|
  category_name = category_dir
  category_path = category_dir
  out.print parts[:category_start].
    sub("{categoryname}", category_name).
    sub("{categoryimg}", Dir.glob(File.join(category_path, "thumb.{png,jpg,jpeg,gif}")).first || phiuri)
	items = Dir.entries(category_path).select do |p| # get subdirecties
    File.directory?(File.join(category_path,p)) &&
    !p[/^\.\.?$/]
  end

  ### Item list
  items.each do |item_dir|
    item_path = File.join(category_path, item_dir)
    item_name = item_dir[item_name_parser,1]
    out.print parts[:item_start].
      sub("{itemname}", item_name).
      sub("{itemimg}", Dir.glob(File.join(item_path, "thumb.{png,jpg,jpeg,gif}")).first || phiuri)
    subitems = Dir.glob(File.join(item_path,"*.gcode"))

    ### Subitems list
    subitems.each do |subitem_file|
      subitem_path = File.join(item_path,subitem_file)
      # parse the filename
      data = subitem_file.match(gcode_name_parser)
      out.print parts[:subitem].
        sub('{description}',
          data[:name] + ", " + 
          data[:printer] + ", " + 
          (data[:nozzle] ? data[:nozzle] + " nozzle, " : "") +
          data[:time]
        ).
        sub("{subitemimg}",
          Dir.glob(subitem_path[/^(.+)\.[^\.]+/] + ".{png,jpg,jpeg,gif}").first || phiuri
        ).
        sub("{filelink}" , subitem_path).
        sub("{filename}" , subitem_file)

    end
    out.print parts[:item_end]
  end
  out.print parts[:category_end]
end
out.print parts[:page_end]

out.close


