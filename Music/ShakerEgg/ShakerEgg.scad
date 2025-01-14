/** Sphere
  * 
  * A mesh generator that generates a shape based on a sphere.
  * Generates spherical coordinates and gets the radius by calling a function.
  * Turns those coordinates into a mesh.
  * Note: for spherical coordinates, this follows the Physics convention:
  * - rho is the distance from the origin
  * - theta is the polar angle, range is 0 (up) to 180 (down)
  * - phi is the azimuthal angle, from -180 to 179.(9), where 0 is +x-axis
**/

function SphereRho(theta,phi) = 
  10+1.75*cos(360*pow(theta/180,0.75)) +
  (theta>58&&theta<112.5 ? (cos(theta*20)*cos(phi*20))*0.3 : 0);//*/

// Generate a sphere with the given number of angles for theta and phi.
// Theta is the polar angle, phi is the azimuthal angle, following
// the physics convention. Calls the function SphereRho(theta,phi)
// to get the radius for each point, then returns a polyhedron.
module Sphere(theta_res,phi_res){
  function withRho(theta, phi) = [SphereRho(theta,phi), theta, phi];
  function sphere_to_cart(pt) = [
    -pt[0]*sin(pt[1])*cos(pt[2]),
    pt[0]*sin(pt[1])*sin(pt[2]),
    pt[0]*cos(pt[1])
  ];
  // generate list of sphere coord points, only one point for each pole
  points = [
    sphere_to_cart(withRho(0,0)), // north pole
    for(ti=[1:theta_res-1]) // skip poles (theta=180/theta_res*ti)
      for(pi=[0:phi_res-1]) // full circle minus last point (phi=360/phi_res*pi-180)
        sphere_to_cart(withRho(180/theta_res*ti, 360/phi_res*pi-180)),
    sphere_to_cart(withRho(180,0)) // south pole
  ];
  
  // fetch a point index based on theta and phi indices
  function point_idx(th_idx, ph_idx) = 1+(th_idx)*(phi_res)+(ph_idx%phi_res);
  
  // build the mesh:
  faces = [
    // first the north pole:
    for(pi=[0:phi_res]) [
      0,
      point_idx(0,pi),
      point_idx(0,pi+1)
    ],
    // then the south pole:
    for(pi=[0:phi_res]) [
      point_idx(theta_res-2, phi_res-1)+1, // (pole)
      point_idx(theta_res-2, pi+1),
      point_idx(theta_res-2, pi)
    ],
    // then each layer
    for(ti=[0:theta_res-3]) // skip poles and last ring
      for(pi=[0:phi_res-1]) [ // full circle minus last point
        point_idx(ti, pi),
        point_idx(ti+1, pi),
        point_idx(ti+1, pi+1),
        point_idx(ti, pi+1)
      ]
  ];
  // finish it
  polyhedron(points=points,faces=faces);
}

h=360;
v=180;

scale([3,3,3]) difference(){
  Sphere(v,h);
  difference(){
    scale([0.97,0.97,0.98]) Sphere(v,h);
    difference(){
      for(a=[0:30:179.9]) rotate([0,0,a]) translate([0,0,10]) cube([0.3,20,20], center=true);
      scale([0.985,0.985,0.945]) Sphere(v,h);
    }
    translate([0,0,-16]) cube(13,center=true);
  }
  union(){
    translate([0,0,-30]) cube(40,center=true);
    *translate([0,0,-20]) cube([30,30,80]);
  }
}