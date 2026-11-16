/* VALEO Shared Design System — tickets.js */
(function(){
'use strict';
/* Company-specific laboratory analysis ticket portal; no assumed URL. */
  var serviceDeskLinks=document.querySelectorAll('[data-ticket-link]');
  var serviceDeskDialog=document.getElementById('serviceDeskDialog');
  var serviceDeskForm=document.getElementById('serviceDeskForm');
  var serviceDeskInput=document.getElementById('serviceDeskUrl');
  var serviceDeskError=document.getElementById('serviceDeskError');
  function savedServiceDesk(){try{return localStorage.getItem('valeoLabAnalysisTicketUrl')||'';}catch(e){return '';}}
  function parseServiceDeskUrl(v){
    var raw=(v||'').trim();
    if(!raw)return null;
    if(!/^https?:\/\//i.test(raw))raw='https://'+raw;
    try{var u=new URL(raw);return (u.protocol==='http:'||u.protocol==='https:')&&u.hostname?u.href:null;}catch(e){return null;}
  }
  serviceDeskLinks.forEach(function(serviceDeskLink){
    serviceDeskLink.addEventListener('click',function(e){
      e.preventDefault();
      if(window.ValeoLabNav)window.ValeoLabNav.close(false);
      var previous=parseServiceDeskUrl(savedServiceDesk());
      if(previous&&!e.shiftKey){window.location.assign(previous);return;}
      if(serviceDeskInput)serviceDeskInput.value=previous||'';
      if(serviceDeskError)serviceDeskError.hidden=true;
      if(serviceDeskDialog&&serviceDeskDialog.showModal){serviceDeskDialog.showModal();serviceDeskInput.focus();}
      else{var typed=prompt('Enter your laboratory analysis ticket portal URL:','');var u=parseServiceDeskUrl(typed);if(u){try{localStorage.setItem('valeoLabAnalysisTicketUrl',u);}catch(e){}window.location.assign(u);}}
    });
  });
  var cancelDesk=document.getElementById('cancelServiceDesk');
  if(cancelDesk)cancelDesk.addEventListener('click',function(){serviceDeskDialog.close();});
  if(serviceDeskForm)serviceDeskForm.addEventListener('submit',function(e){
    e.preventDefault();var url=parseServiceDeskUrl(serviceDeskInput.value);
    if(!url){serviceDeskError.textContent='Enter a valid HTTP or HTTPS laboratory ticket portal URL.';serviceDeskError.hidden=false;return;}
    try{localStorage.setItem('valeoLabAnalysisTicketUrl',url);}catch(_e){}
    serviceDeskDialog.close();window.location.assign(url);
  });
})();
