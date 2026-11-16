/* VALEO Shared Design System — theme.js */
(function(){
'use strict';

  'use strict';
  /* Theme choice persists when browser storage is available. */
  var themeButtons=Array.from(document.querySelectorAll('[data-theme-option]'));
  var themeMeta=document.getElementById('themeColor');
  var storedTheme='stella';
  try{storedTheme=localStorage.getItem('valeoOperationsTheme')||'stella';}catch(_e){}
  function setTheme(name){
    var theme=name==='metroid'?'metroid':'stella';
    document.documentElement.setAttribute('data-theme',theme);
    themeButtons.forEach(function(button){var active=button.dataset.themeOption===theme;button.setAttribute('aria-pressed',String(active));button.setAttribute('aria-label',active?'Current theme: '+(theme==='metroid'?'Metroid':'Stella'):'Switch to '+(button.dataset.themeOption==='metroid'?'Metroid':'Stella')+' theme');});
    if(themeMeta) themeMeta.setAttribute('content',theme==='metroid'?'#07030d':'#f2fdfb');
    try{localStorage.setItem('valeoOperationsTheme',theme);}catch(_e){}
  }
  /* Crossfade the theme, then briefly scan the holographic screen with a
     translucent one-second glitch (ice blue for Stella, orange for Metroid). */
  var prefersReducedMotion=window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)');
  var heroPanel=document.querySelector('.hero');
  var themeSwitchCount=0;
  function flashHeroForTheme(name,sequence){
    if(sequence!==themeSwitchCount || document.documentElement.dataset.theme!==name)return;
    if(!heroPanel || (prefersReducedMotion && prefersReducedMotion.matches))return;
    heroPanel.classList.remove('is-theme-flashing');
    /* Restart the pulse cleanly, even if a technician switches modes rapidly. */
    void heroPanel.offsetWidth;
    heroPanel.classList.add('is-theme-flashing');
  }
  function selectThemeSmoothly(name){
    var next=name==='metroid'?'metroid':'stella';
    if(document.documentElement.dataset.theme===next)return;
    var sequence=++themeSwitchCount;
    if(heroPanel)heroPanel.classList.remove('is-theme-flashing');
    if(prefersReducedMotion && prefersReducedMotion.matches){setTheme(next);return;}
    if(typeof document.startViewTransition==='function'){
      var vt=document.startViewTransition(function(){setTheme(next);});
      vt.finished.then(function(){flashHeroForTheme(next,sequence);},function(){flashHeroForTheme(next,sequence);});
    }else{
      var wash=document.createElement('div');
      wash.className='theme-transition-fallback';
      wash.style.setProperty('--fallback-wash',next==='metroid'?'rgba(229,63,55,.2)':'rgba(33,158,241,.16)');
      document.body.appendChild(wash);
      setTheme(next);
      wash.addEventListener('animationend',function(){wash.remove();flashHeroForTheme(next,sequence);},{once:true});
    }
  }
  themeButtons.forEach(function(button){button.addEventListener('click',function(){selectThemeSmoothly(button.dataset.themeOption);});});
  setTheme(storedTheme);
})();
