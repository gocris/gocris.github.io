/* VALEO Shared Design System — ambient.js */
(function(){
'use strict';
/* Visible but restrained theme particles: diamonds for Stella, elegant digital fragments for Metroid. */
  var canvas=document.getElementById('ambientParticles');
  var ctx=canvas && canvas.getContext('2d');
  var reducedMotion=window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  var particles=[],screenW=0,screenH=0,dpr=1,prevTime=0;
  function seededParticles(){
    if(!ctx)return;
    var count=Math.min(94,Math.max(40,Math.floor(screenW*screenH/16800)));
    particles=Array.from({length:count},function(_,i){
      return {x:Math.random()*screenW,y:Math.random()*screenH,
        size:3.3+Math.random()*6.5,
        speed:(.105+Math.random()*.21),phase:Math.random()*Math.PI*2,
        rot:Math.random()*Math.PI,kind:i%6};
    });
  }
  function resizeParticles(){
    if(!ctx)return;
    screenW=window.innerWidth;screenH=window.innerHeight;
    dpr=Math.min(window.devicePixelRatio||1,2);
    canvas.width=Math.round(screenW*dpr);canvas.height=Math.round(screenH*dpr);
    ctx.setTransform(dpr,0,0,dpr,0,0);
    seededParticles();
  }
  function drawParticles(t){
    if(!ctx || reducedMotion)return;
    requestAnimationFrame(drawParticles);
    if(document.hidden)return;
    var dt=Math.min(45,(t-prevTime)||16.7)/16.7;prevTime=t;
    var dark=document.documentElement.dataset.theme==='metroid';
    ctx.clearRect(0,0,screenW,screenH);
    for(var i=0;i<particles.length;i++){
      var p=particles[i];
      p.y-=p.speed*dt*(dark?.68:1);p.x+=Math.sin(t*.00031+p.phase)*.14*dt;
      if(p.y < -24){p.y=screenH+20;p.x=Math.random()*screenW;}
      var shimmer=.72+.28*Math.sin(t*.0008+p.phase);
      if(!dark){
        ctx.save();ctx.translate(p.x,p.y);ctx.rotate(Math.PI/4+p.rot*.12);
        var alpha=(p.kind%3===0?.58:.39)*shimmer;
        ctx.strokeStyle='rgba(6,153,157,'+alpha+')';
        ctx.lineWidth=p.kind%3===0?1.4:1.05;
        ctx.shadowColor='rgba(46,220,199,.28)';ctx.shadowBlur=p.kind%3===0?5:0;
        ctx.strokeRect(-p.size/2,-p.size/2,p.size,p.size);
        ctx.shadowBlur=0;
        if(p.kind%4===0){
          ctx.fillStyle='rgba(24,195,177,'+(.14*shimmer)+')';
          ctx.fillRect(-p.size/2+1,-p.size/2+1,Math.max(p.size-2,1),Math.max(p.size-2,1));
        }
        ctx.restore();
      }else{
        /* Soft corrupted pixel fragments, never flashing or covering text. */
        var red=p.kind%2===0;
        var alpha=(p.kind%3===0?.47:.29)*shimmer;
        ctx.fillStyle=(red?'rgba(255,56,103,':'rgba(178,95,250,')+alpha+')';
        var ww=5+p.size*1.9;
        ctx.fillRect(p.x,p.y,ww,p.kind%3===0?1.5:1);
        if(p.kind%3===0)ctx.fillRect(p.x+ww*.68,p.y+3,1.5,3.5);
        if(p.kind===1){
          ctx.fillStyle='rgba(189,126,255,'+(.20*shimmer)+')';
          ctx.fillRect(p.x-2,p.y-4,2,2);
        }
      }
    }
  }
  if(ctx && !reducedMotion){
    resizeParticles();window.addEventListener('resize',resizeParticles,{passive:true});
    requestAnimationFrame(drawParticles);
  }
})();
