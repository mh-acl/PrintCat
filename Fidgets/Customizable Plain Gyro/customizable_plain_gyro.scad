// customizable plain gyro

// Number of rings in the gyro.
rings = 3;

// Diameter of the outside of the largest ring.
outer_diameter = 40; // [5:0.1:200]

// Thickness of each ring (difference between its inner and outer diameters)
thickness = 3; // [0.5:0.1:40]

// Width of each ring (height when laid flat)
width = 4; // [3:0.1:40]

// Gap between rings. If this is too small compared to the width, rings won't spin.
gap = 1.5; // [0.2:0.1:10]

// Ratio of depth of cut for the bearing. 1 will graze the spin path of the ring inside, 0 will not quite connect. You may want higher numbers for materials that are more flexible.
cut = 0.5; // [0:0.1:1]

// Gap between bearing surfaces. Too tight may fuse when printing, too loose may fall apart.
bearing_gap = 0.5; // [0.1:0.05:5]

// Angle to print the cone part of the bearing at. Adjust if your printer is better or worse at printing overhangs. 0 would be vertical, 90 horizontal.
angle = 55; //[15:1:75]


$fa=1/1;
$fs=1/1;

Gyro(n=rings, od=outer_diameter, th=thickness, h=width, gap=gap, bgap=bearing_gap, cut=cut, a=angle);


module Gyro(n, od, th, h, gap, bgap, cut, a){
  // loop through the rings, outside to inside
  for(i=[0:n-1]){
    // od/id of current ring
    cod = od-(th+gap)*2*i;
    cid = cod-th*2;
    // bearing cone sizes
    bh = (gap*2+th)*cut;
    bw = bh*2/tan(a);
    
    
    // each ring's bearings are rotated by 90 degrees from each other
    rotate([0,0,90*i]){
      difference(){
        // outer edge of ring
        cylinder(d=cod, h=h);
        // inner edge of ring (overcut)
        cylinder(d=cid, h=h*3, center=true);
        // if it's not the outside ring, cut the inset bearing
        if(i!=0)
          for(dir=[1,-1])
            // rotate, then translate out to inner diameter of enclosing ring, minus bearing gap
            translate([dir*(cod/2+gap-bgap),0,h/2]) rotate([0,-90*dir,0])
              cylinder(d1=bw, h=bh, d2=0);
      } // done cutting
      // if not the inside ring, make the outset bearing
      if(i!=n-1){
        // make sure the base of the bearing cone doesn't go out of bounds
        intersection(){
          for(dir=[1,-1])
            // rotate, then translate out to inner diameter
            rotate([0,0,90])translate([dir*cid/2,0,h/2]) rotate([0,-90*dir,0])
              cylinder(d1=bw, h=bh, d2=0);
          // clip to height and outer diameter of ring, just in case
          cylinder(h=h,d=cod);
        }
      }
    }
  }
} 

