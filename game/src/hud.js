// The HUD: every number and panel on screen, driven by the game and
// nothing else. The DOM lives in index.html; this module only writes
// text, widths and classes, and never reads game state back.
export function createHud() {
  const el = (id) => document.getElementById(id);
  const healthFill = el('health-fill');
  const healthNum = el('health-num');
  const armorTag = el('armor-tag');
  const ammoMag = el('ammo-mag');
  const ammoReserve = el('ammo-reserve');
  const ammoBox = el('ammo');
  const moneyEl = el('money');
  const timerEl = el('timer');
  const scoreEl = el('score');
  const phaseEl = el('phase');
  const feed = el('killfeed');
  const hitmarker = el('hitmarker');
  const crosshair = el('crosshair');
  const damage = el('damage');
  const bombBar = el('bomb-bar');
  const bombWrap = el('bomb-timer');
  const channelWrap = el('channel');
  const channelFill = el('channel-fill');
  const channelLabel = el('channel-label');
  const hintEl = el('hint');
  const toastEl = el('toast');
  const overlays = {
    start: el('overlay-start'),
    paused: el('overlay-paused'),
    round: el('overlay-round'),
    match: el('overlay-match'),
    buy: el('buy-menu'),
  };
  let toastTimer = 0;
  let hitTimer = 0;

  function showOnly(name) {
    for (const [key, panel] of Object.entries(overlays)) {
      if (key === 'buy') continue;
      if (panel) panel.hidden = key !== name;
    }
  }

  return {
    setHealth(hp, armor) {
      healthFill.style.width = `${Math.max(0, hp)}%`;
      healthNum.textContent = String(Math.ceil(hp));
      healthFill.classList.toggle('low', hp <= 30);
      armorTag.hidden = !armor;
    },
    setAmmo(mag, reserve, reloading) {
      ammoMag.textContent = String(mag);
      ammoReserve.textContent = `/ ${reserve}`;
      ammoBox.classList.toggle('empty', mag === 0);
      ammoBox.classList.toggle('reloading', reloading);
    },
    setMoney(amount) {
      moneyEl.textContent = `$${amount.toLocaleString('en-US')}`;
    },
    setTimer(seconds, planted) {
      const total = Math.max(0, Math.ceil(seconds));
      const mm = Math.floor(total / 60);
      const ss = String(total % 60).padStart(2, '0');
      timerEl.textContent = `${mm}:${ss}`;
      timerEl.classList.toggle('planted', planted);
    },
    setScore(ember, slate, round) {
      scoreEl.innerHTML = `EMBER <b>${ember}</b> — <b>${slate}</b> SLATE &nbsp;·&nbsp; ROUND ${round}`;
    },
    setPhase(text) {
      phaseEl.textContent = text;
    },
    setHint(text) {
      hintEl.textContent = text;
      hintEl.hidden = !text;
    },
    setBomb(fuse, total) {
      if (fuse === null) {
        bombWrap.hidden = true;
        return;
      }
      bombWrap.hidden = false;
      bombBar.style.width = `${Math.max(0, (fuse / total) * 100)}%`;
    },
    setChannel(label, frac) {
      if (frac === null) {
        channelWrap.hidden = true;
        return;
      }
      channelWrap.hidden = false;
      channelLabel.textContent = label;
      channelFill.style.width = `${Math.round(frac * 100)}%`;
    },
    setCrosshair(spreadPx, aiming) {
      crosshair.style.setProperty('--gap', `${spreadPx.toFixed(1)}px`);
      crosshair.classList.toggle('aiming', aiming);
    },
    killfeed(killerTeam, killer, victimTeam, victim, head) {
      const row = document.createElement('div');
      row.className = 'feed-row';
      const color = (team) => (team === 'ember' ? '#ff9a2a' : '#3fb6c9');
      row.innerHTML = `<span style="color:${color(killerTeam)}">${killer}</span> ${head ? '◉' : '✕'} <span style="color:${color(victimTeam)}">${victim}</span>`;
      feed.prepend(row);
      while (feed.children.length > 5) feed.lastChild.remove();
      setTimeout(() => row.remove(), 6000);
    },
    hitmarker(kill) {
      hitmarker.classList.add('on');
      hitmarker.classList.toggle('kill', kill);
      clearTimeout(hitTimer);
      hitTimer = setTimeout(() => hitmarker.classList.remove('on', 'kill'), 140);
    },
    damageFlash() {
      damage.classList.remove('flash');
      void damage.offsetWidth;
      damage.classList.add('flash');
    },
    toast(text) {
      toastEl.textContent = text;
      toastEl.hidden = false;
      clearTimeout(toastTimer);
      toastTimer = setTimeout(() => {
        toastEl.hidden = true;
      }, 2600);
    },
    showOverlay(name, data = {}) {
      showOnly(name);
      if (name === 'round' && data.title) {
        el('round-title').textContent = data.title;
        el('round-sub').textContent = data.sub ?? '';
        el('round-score').textContent = data.score ?? '';
      }
      if (name === 'match' && data.title) {
        el('match-title').textContent = data.title;
        el('match-sub').textContent = data.sub ?? '';
      }
    },
    hideOverlay() {
      showOnly(null);
    },
    showBuy(visible) {
      overlays.buy.hidden = !visible;
    },
    setBuyItems(items, money) {
      const list = el('buy-list');
      list.innerHTML = '';
      items.forEach((item, index) => {
        const row = document.createElement('button');
        row.className = 'buy-row';
        row.disabled = money < item.price;
        row.innerHTML = `<span class="buy-key">${index + 1}</span><span class="buy-name">${item.name}</span><span class="buy-price">$${item.price.toLocaleString('en-US')}</span>`;
        row.addEventListener('click', () => {
          document.dispatchEvent(new CustomEvent('emberline-buy', { detail: item.id }));
        });
        list.appendChild(row);
      });
    },
    onPlay(callback) {
      el('play-button').addEventListener('click', callback);
    },
    onResume(callback) {
      el('resume-button').addEventListener('click', callback);
    },
    onRestart(callback) {
      const button = el('restart-button');
      if (button) button.addEventListener('click', callback);
    },
  };
}
