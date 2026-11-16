/* Remove the entry state after the final card has resolved. */
(function(){
  'use strict';
  if(!document.documentElement.classList.contains('has-entrance'))return;
  window.setTimeout(function(){
    document.documentElement.classList.remove('has-entrance');
  },1620);
  /* Avoid replaying entrance frames when returning from the browser's back cache. */
  window.addEventListener('pageshow',function(event){
    if(event.persisted)document.documentElement.classList.remove('has-entrance');
  });
})();
