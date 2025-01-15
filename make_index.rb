#!/usr/bin/ruby
#
# make_index.rb
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
  <style>
    :root{
      --page-bg: #eef;
      --panel-bg: #ccf;
      --border-line: #99f;
    }
    body{
      background: var(--page-bg);
    }
    #categories,#items,#subitems{
      white-space: nowrap;
      overflow-x: hidden;
      background: linear-gradient(
        to top,
        var(--border-line) 1px,
        var(--panel-bg) 1px)
      ;
      font-size: 0;
      border-left: 1px solid var(--border-line);
      border-right: 1px solid var(--border-line);
    }
    #categories{
      background: linear-gradient(
        to top,
        var(--border-line) 1px,
        var(--page-bg) 1px)
      ;
      border: none;
    }
    #categories>*,#items>*>*,#subitems>*>*{
      font-size: initial;
    }
    label,span.subitem{
      margin: 1em 0 0 0;
      padding: 1em;
      border-radius: 1em;
      border: 1px solid var(--border-line);
      background-color: var(--panel-bg);
      display: inline-block;
      text-align: center;
      vertical-align: top;
    }
    label{
      border-radius: 1em 1em 0em 0em;
      border-left-width: 0px;
    }
    label:first-of-type{
      border-left-width: 1px;
    }
    label:not(.active){
      background-color: var(--panel-bg);
      background-image: linear-gradient(to top, rgba(0,0,0,0.1) 0em, transparent 0.25em);
    }
    span.subitem>ul{
      display: block;
      text-align: initial;
    }
    span.reveal{
      display:none;
      font-size: 0px;
    }
    span.reveal>*{
      font-size: initial;
    }
    input{
      display: none;
    }
    input:checked + span.reveal{
      display: initial;
    }
    img.thumb{
      max-height: 5em;
    }
    img.bigthumb{
      max-height: 12em;
    }
    span.caption::before{
      content: "";
      display: block;
    }
    label.active{
      background-color: var(--panel-bg);
      border-radius: 1em 1em 0em 0em;
      border-bottom: 1px solid var(--panel-bg);
    }
    ul.notes{
      list-style: none;
      padding: 0;
    }
    }
  </style>
  <script>
  document.addEventListener("DOMContentLoaded", ()=>{
    document.querySelectorAll("label").forEach( (lbl)=>{
      lbl.addEventListener("click", (e)=>{
        lbl.parentElement.querySelectorAll("label").forEach((_lbl)=>{
          if(_lbl==lbl){
            _lbl.classList.add("active");
          }else{
            _lbl.classList.remove("active");
          }
        })
        if(lbl.parentElement.id == "categories"){
          document.getElementById("it").reset();
          document.getElementById("si").reset();
          document.querySelector("#items label.active").classList.remove("active");
        } else if(lbl.parentElement.id == "items"){
          document.getElementById("si").reset();
        }
        lbl.click()
      })
    })
    document.getElementById("ct").reset();
    document.getElementById("it").reset();
    document.getElementById("si").reset();
  })
  </script>
</head>
<body>
<h1>Member Print Catalog</h1>
<form id="ct">
<div id=categories>', 
  categories: '
  <label for="{categoryid}">
    <img src="{categoryimg}" class=thumb>
    <span class=caption>{categoryname}</span>
  </label>',
  after_categories: '
</div>
</form>

<form id="it">
<div id=items>',
  category_items: '
  <input id="{categoryid}" type=radio name=items>
  <span class=reveal>',
  items: '
    <label for={itemid}>
      <img src="{itemimg}" class=thumb>
      <span class=caption>{itemname}</span>
    </label>',
  after_items: '
  </span>',
  after_category_items: '
</div>
</form>

<form id="si">
<div id=subitems>',
  item_subitems: '
  <input id="{itemid}" type=radio name=subitems>
  <span class=reveal>',
  subitems: '
    <span class="subitem">
      <a href="{subitempath}" download="{subitemfilename}">
        <img src="{subitemimg}" class=bigthumb>
      </a>
      <ul class=notes>',
  subitem_notes: '
        <li>{note}</li>',
  after_subitem_notes: '
      </ul>
    </span>',
  after_subitems: '
  </span>',
  after_item_subitems: '
</div>
</form>
</body>
</html>'
}

# placeholder image
noimg = "nothumb.png"


gcode_name_parser = /
  ^(?<name>.+?)_
  ((?<nozzle>[\d\.]+)n_)? # optional nozzle size
  (?<layer_height>[\d\.]+mm)_
  (?<material>[^_]+)_
  (?<printer>[^_]+)_
  (?<time>[\dhm]+)\.gcode$
/x

item_name_parser = /^(.+?)(?:\s+\-\s[\d\(\)]+)?$/









## page start
out.print parts[:page_start]

## category list
categories = Dir.entries(Dir.pwd).select do |f| # select actual subdirectories
  File.directory?(f) && # must be directory and
  !f[/^\./]             # not a dot directory
end
categories.each do |category_dir|
  category_path = category_dir
  category_id = category_dir.gsub(/[^[:alnum:]]/, "_")
  category_img = Dir.glob(File.join(category_path, "thumb.{png,jpg,jpeg,gif}")).first || noimg
  category_name = category_dir
  out.print parts[:categories].
    gsub("{categoryid}", category_id).
    gsub("{categoryimg}", category_img).
    gsub("{categoryname}", category_name)
end
out.print parts[:after_categories]


## items list
categories.each do |category_dir|
  category_path = category_dir
  category_id = category_dir.gsub(/[^[:alnum:]]/, "_")
  out.print parts[:category_items].
    gsub("{categoryid}",category_id)

  items = Dir.entries(category_path).select do |f| # get subdirectories
    File.directory?(File.join(category_path,f)) &&
    !f[/^\./]
  end
  items.each do |item_dir|
    item_path = File.join(category_path, item_dir)
    item_id = category_id + "_" + item_dir.gsub(/[^[:alnum:]]/, "_")
    item_name = item_dir[item_name_parser,1]
    item_img = Dir.glob(File.join(item_path, "thumb.{png,jpg,jpeg,gif}")).first || noimg
    out.print parts[:items].
      gsub('{itemid}',item_id).
      gsub('{itemimg}',item_img).
      gsub('{itemname}',item_name)
  end
  out.print parts[:after_items]
end
out.print parts[:after_category_items]


## subitems list
categories.each do |category_dir|
  category_id = category_dir.gsub(/[^[:alnum:]]/, "_")
  category_path = category_dir
  items = Dir.entries(category_path).select do |f| # get subdirectories
    File.directory?(File.join(category_path,f)) &&
    !f[/^\./]
  end
  items.each do |item_dir|
    item_path = File.join(category_path, item_dir)
    item_id = category_id + "_" + item_dir.gsub(/[^[:alnum:]]/, "_")
    out.print parts[:item_subitems].
      gsub("{itemid}",item_id)

    subitems = Dir.chdir(item_path){Dir.glob("*.gcode")}
    subitems.each do |subitem_file|
      subitem_path = File.join(item_path,subitem_file)
      # get subitem info
      data = subitem_file.match(gcode_name_parser)
      subitem_img = Dir.glob(File.join(item_path, data[:name]+".{png,jpg,jpeg,gif}")).first || noimg
      notes = [
        data[:name].gsub(/\s+\(turbo\)/,""),
        "Printer: " +
          ((data[:printer]=="MK3S"&&data[:nozzle]=="0.6") ? 
          "Prusa MK3S (Turbo)" : "Prusa MK3S"),
        "Print Time: " + data[:time],
        "Layers: " + data[:layer_height]#,
       #"Filament: " + data[:material]
      ]
      # output subitem
      out.print parts[:subitems].
        gsub("{subitempath}",subitem_path).
        gsub("{subitemfilename}",subitem_file).
        gsub("{subitemimg}",subitem_img)
      notes.each do |note|
        out.print parts[:subitem_notes].
          gsub("{note}", note) if note
      end
      out.print parts[:after_subitem_notes]
    end
    out.print parts[:after_subitems]
  end
end
out.print parts[:after_item_subitems]

out.close