/* Apply saved theme before CSS paints; animate on fresh page entry. */
(function(){
  try{if(localStorage.getItem('valeoOperationsTheme')==='metroid')document.documentElement.dataset.theme='metroid';}catch(e){}
  try{
    if(!(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches)){
      document.documentElement.classList.add('has-entrance');
    }
  }catch(e){}
})();
