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
      background-color: var(--tab-inactive-bg);
      display: inline-block;
      text-align: center;
    }
    label{
      border-radius: 1em 1em 0em 0em;
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
noimg = "data:image/svg+xml,%3C%3Fxml version='1.0' encoding='UTF-8' standalone='no'%3F%3E%3Csvg viewBox='0 0 311 390' version='1.1' xmlns='http://www.w3.org/2000/svg' xmlns:svg='http://www.w3.org/2000/svg'%3E%3Cg stroke='none' stroke-width='1' fill='none' fill-rule='evenodd' id='g3' transform='translate(0.13510201,39.302948)'%3E%3Cg transform='translate(-0.491704)' fill='%23000000' id='g2'%3E%3Cpath d='M 159.24394,183.80438 38.842912,304.56816 c -8.678862,8.70501 -22.771276,8.72621 -31.4762863,0.0473 -0.019492,-0.0194 -0.038947,-0.0389 -0.058367,-0.0584 -8.7144308,-8.75296 -8.7094661,-22.90502 0.011104,-31.65186 L 127.79471,152.06692 c -9.42976,-15.21513 -14.87626,-33.17556 -14.87626,-52.412741 0,-54.881021 44.32808,-99.37087986 99.00954,-99.37087986 54.68145,0 99.00953,44.48985886 99.00953,99.37087986 0,54.881021 -44.32808,99.370881 -99.00953,99.370881 -19.36225,0 -37.42638,-5.57818 -52.68405,-15.22068 z m 52.68405,-2.07859 c 45.16207,0 81.77316,-36.74471 81.77316,-82.071611 0,-45.326898 -36.61109,-82.07161 -81.77316,-82.07161 -45.16208,0 -81.77317,36.744712 -81.77317,82.07161 0,45.326901 36.61109,82.071611 81.77317,82.071611 z' fill-rule='nonzero' id='path1' /%3E%3Cpath d='m 175.7712,73.154854 c 0.39021,-19.101958 13.96982,-32.457799 37.92924,-32.457799 22.3205,0 37.07076,12.346388 37.07076,30.050642 0,11.725185 -5.69719,19.87846 -16.70136,26.32343 -10.37981,5.979073 -13.26743,9.783933 -13.26743,17.393653 v 4.11546 h -20.68158 l -0.15609,-4.50371 c -1.01456,-12.19109 3.27784,-19.17961 14.04787,-25.469279 10.06764,-5.979068 13.11134,-9.78393 13.11134,-17.160702 0,-7.376773 -5.93132,-12.734639 -14.8283,-12.734639 -8.97503,0 -14.90635,5.668467 -15.37461,14.442944 z m 34.96358,82.542196 c -7.02394,0 -12.72113,-5.35786 -12.72113,-12.19108 0,-6.83322 5.69719,-12.19109 12.72113,-12.19109 7.10197,0 12.79916,5.35787 12.79916,12.19109 0,6.83322 -5.69719,12.19108 -12.79916,12.19108 z' id='path2' /%3E%3C/g%3E%3C/g%3E%3C/svg%3E%0A"


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
      warn([item_path, data[:name], File.join(item_path, data[:name]+".{png,jpg,jpeg,gif}")].inspect)
      subitem_img = Dir.glob(File.join(item_path, data[:name]+".{png,jpg,jpeg,gif}")).first || noimg
      notes = [
        data[:name],
        "Printer: " + data[:printer],
        "Print Time: " + data[:time],
        data[:nozzle] ? ("Nozzle: " + data[:nozzle]) : nil,
        "Layers: " + data[:layer_height],
        "Filament: " + data[:material]
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