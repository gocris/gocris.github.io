/* VALEO Shared Design System — navigation.js */
(function(){
'use strict';

  var prefersReducedMotion=window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)');
/* Header orb: animated slide-out navigation with accessible focus handling. */
  var navOpenButton=document.getElementById('navOpenButton');
  var navCloseButton=document.getElementById('navCloseButton');
  var navSidePanel=document.getElementById('labSidePanel');
  var navSideBackdrop=document.getElementById('navSideBackdrop');
  var navToolsGroup=document.getElementById('navToolsGroup');
  var navToolsToggle=document.getElementById('navToolsToggle');
  var navToolsCollapse=document.getElementById('navToolsCollapse');
  var lastNavFocus=null;
  function openNav(){
    if(document.body.classList.contains('nav-open'))return;
    lastNavFocus=document.activeElement;
    navSidePanel.inert=false;
    navSidePanel.setAttribute('aria-hidden','false');
    navOpenButton.setAttribute('aria-expanded','true');
    document.body.classList.add('nav-open');
    navCloseButton.focus({preventScroll:true});
  }
  function closeNav(restoreFocus){
    if(!document.body.classList.contains('nav-open'))return;
    document.body.classList.remove('nav-open');
    navOpenButton.setAttribute('aria-expanded','false');
    navSidePanel.setAttribute('aria-hidden','true');
    navSidePanel.inert=true;
    if(restoreFocus!==false && lastNavFocus && lastNavFocus.focus)lastNavFocus.focus({preventScroll:true});
  }
  if(navOpenButton)navOpenButton.addEventListener('click',openNav);
  if(navCloseButton)navCloseButton.addEventListener('click',function(){closeNav(true);});
  if(navSideBackdrop)navSideBackdrop.addEventListener('click',function(){closeNav(true);});
  if(navSidePanel)navSidePanel.querySelectorAll('a:not([data-ticket-link])').forEach(function(a){a.addEventListener('click',function(){closeNav(false);});});
  document.addEventListener('keydown',function(e){
    if(e.key==='Escape' && document.body.classList.contains('nav-open')){e.preventDefault();closeNav(true);}
    if(e.key!=='Tab' || !document.body.classList.contains('nav-open'))return;
    var nodes=Array.from(navSidePanel.querySelectorAll('button:not([disabled]),a[href]')).filter(function(el){return !el.closest('[inert]') && el.getClientRects().length;});
    if(!nodes.length)return;
    if(e.shiftKey && document.activeElement===nodes[0]){e.preventDefault();nodes[nodes.length-1].focus();}
    else if(!e.shiftKey && document.activeElement===nodes[nodes.length-1]){e.preventDefault();nodes[0].focus();}
  });
  if(navToolsToggle)navToolsToggle.addEventListener('click',function(){
    var expand=!navToolsGroup.classList.contains('is-expanded');
    navToolsGroup.classList.toggle('is-expanded',expand);
    navToolsToggle.setAttribute('aria-expanded',String(expand));
    navToolsCollapse.inert=!expand;
    if(expand){
      window.setTimeout(function(){
        if(!navToolsGroup.classList.contains('is-expanded'))return;
        var finalItem=navToolsCollapse.querySelector('.nav-tools-item:last-of-type');
        if(!finalItem)return;
        var bottom=finalItem.getBoundingClientRect().bottom;
        var visibleBottom=navSidePanel.getBoundingClientRect().bottom-25;
        if(bottom>visibleBottom){
          navSidePanel.scrollBy({top:bottom-visibleBottom,behavior:prefersReducedMotion&&prefersReducedMotion.matches?'auto':'smooth'});
        }
      },470);
    }
  });
  /* One reversible height animation per expandable master card. Height and
     contents are coordinated, preventing the jump/glitch on fast repeat clicks. */
  document.querySelectorAll('#modules > details.module--group').forEach(function(group){
    var trigger=group.querySelector('summary');
    var panel=group.querySelector('.module-branches');
    var activeAnimation=null;
    var generation=0;
    var expandTimer=null;
    var expanded=group.open;
    group.classList.toggle('is-expanded',expanded);
    function scrollBranchesIntoView(){
      if(!expanded || !group.open)return;
      var last=panel&&panel.querySelector('.module-branch:last-of-type');
      var node=last||panel;
      if(!node)return;
      var bounds=node.getBoundingClientRect();
      var safeBottom=window.innerHeight-26;
      if(bounds.bottom>safeBottom){
        window.scrollBy({top:Math.ceil(bounds.bottom-safeBottom),
          behavior:prefersReducedMotion&&prefersReducedMotion.matches?'auto':'smooth'});
      }
    }
    trigger.addEventListener('click',function(event){
      event.preventDefault();
      var openNext=!expanded;
      expanded=openNext;
      var token=++generation;
      if(expandTimer){window.clearTimeout(expandTimer);expandTimer=null;}
      /* Grab the currently displayed height BEFORE cancelling an earlier animation. */
      var startHeight=group.getBoundingClientRect().height;
      if(activeAnimation){activeAnimation.cancel();activeAnimation=null;}
      group.style.height=startHeight+'px';
      if(openNext)group.open=true;
      group.classList.toggle('is-expanded',openNext);
      if(prefersReducedMotion&&prefersReducedMotion.matches){
        group.open=openNext;
        group.style.removeProperty('height');
        group.classList.remove('is-animating','is-opening','is-closing');
        if(openNext)requestAnimationFrame(scrollBranchesIntoView);
        return;
      }
      /* With details open, scrollHeight contains the full branch list. */
      var finalHeight=openNext?group.scrollHeight:trigger.getBoundingClientRect().height;
      group.classList.add('is-animating');
      group.classList.toggle('is-opening',openNext);
      group.classList.toggle('is-closing',!openNext);
      activeAnimation=group.animate([
        {height:startHeight+'px'},
        {height:finalHeight+'px'}
      ],{duration:560,easing:'cubic-bezier(.22,.78,.22,1)',fill:'forwards'});
      var thisAnimation=activeAnimation;
      thisAnimation.finished.then(function(){
        if(token!==generation)return;
        if(!openNext)group.open=false;
        group.style.removeProperty('height');
        thisAnimation.cancel();
        group.classList.remove('is-animating','is-opening','is-closing');
        if(activeAnimation===thisAnimation)activeAnimation=null;
        if(openNext){requestAnimationFrame(scrollBranchesIntoView);}
      }).catch(function(){});
    });
  });

  
  window.ValeoLabNav={close:closeNav};
})();
