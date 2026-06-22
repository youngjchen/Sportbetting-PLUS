/* ============================================================
   logo-map.js — 隊名(LEAGUES) → ./Logo/ 隊徽檔 對照 + 顯示元件
   給比賽卡渲染用：teamLogoEl(隊名, 尺寸) 回一個白圓底座包住隊徽的節點，
   載入失敗時自動退回隊名首字。隊名以 index.html 的 LEAGUES.teams 為準。
   ============================================================ */
(function (global) {
  var TEAM_LOGO = {
    /* ---- MLB (30) ---- */
    "金鶯": "ALE-BAL-Insignia_II.png",
    "紅襪": "Boston_Red_Sox_cap_logo.svg",
    "洋基": "New_York_Yankees_Primary_Logo.svg",
    "光芒": "Tampa_Bay_Rays_cap_logo.svg",
    "藍鳥": "TorontoBlueJays2012primary.png",
    "白襪": "Chicago_White_Sox.svg",
    "守護者": "Cleveland_Guardians_cap_logo.svg",
    "老虎": "Detroit_Tigers_logo.svg",
    "皇家": "Kansas_City_Royals_Insignia.svg",
    "雙城": "Minnesota_Twins_Insignia.svg",
    "太空人": "Houston-Astros-Logo.svg",
    "天使": "Los_Angeles_Angels_of_Anaheim_Insignia.svg",
    "運動家": "Athletics_logo.svg",
    "水手": "Seattle_Mariners_Insignia.svg",
    "遊騎兵": "Texas_Rangers.svg",
    "勇士": "Atlanta_Braves_Insignia.svg",
    "馬林魚": "Miami_Marlins_logo.png",
    "大都會": "New_York_Mets.svg",
    "費城人": "Philadelphia_Phillies_Insignia.svg",
    "國民": "Washington_Nationals_logo.svg",
    "小熊": "Chicago_Cubs_logo.svg",
    "紅人": "Cincinnati_Reds_Logo.svg",
    "釀酒人": "Milwaukee_Brewers_logo.svg",
    "海盜": "Pittsburgh_Pirates_Cap_Insignia.svg",
    "紅雀": "St._Louis_Cardinals_Logo.svg",
    "響尾蛇": "Arizona_Diamondbacks_logo_teal.svg",
    "落磯": "Colorado_Rockies_Cap_Insignia.svg",
    "道奇": "LA_Dodgers.svg",
    "教士": "San_Diego_Padres_(2020)_cap_logo.svg",
    "巨人": "San_Francisco_Giants_Cap_Insignia.svg",

    /* ---- 日職 NPB (12) ---- */
    "讀賣巨人": "Yomiuri_Giants_logo.svg",
    "阪神虎": "Hanshin_tigers_insignia.png",
    "橫濱DeNA": "Yokohama_DeNA_BayStars_insignia.png",
    "廣島鯉魚": "Hiroshima_Toyo_Carp_insignia.png",
    "養樂多燕子": "Tokyo_Yakult_Swallows_logo_vector.svg",
    "中日龍": "ChunichiDragons.png",
    "軟銀鷹": "Fukuoka_SoftBank_Hawks_insignia.svg",
    "日本火腿": "Hokkaido_Nippon-Ham_Fighters_insignia.svg",
    "羅德": "Chiba_Lotte_Marines_insignia.png",
    "樂天金鷲": "Rakuten_eagles_insignia.svg",
    "西武獅": "Seibu_lions_insignia.svg",
    "歐力士": "Orix_Buffaloes_insignia.png",

    /* ---- 韓職 KBO (10) ---- */
    "LG雙子": "LG_Twins_2017.png",
    "KT巫師": "KT巫師隊徽.png",
    "SSG登陸者": "SSG_Landers_LOGO.png",
    "NC恐龍": "Emblem_Home_Navy_Background.png",
    "斗山熊": "斗山熊logo.png",
    "起亞虎": "Kia_Tigers_logo.png",
    "樂天巨人": "Lotte_Giants.png",
    "三星獅": "三星獅logo.png",
    "韓華鷹": "Hanwha_Eagles_text_logo.png",
    "培證英雄": "Kiwoom_Heroes.png",

    /* ---- 中職 CPBL (6) ---- */
    "中信兄弟": "Cpbl-stats-chinatrust-brothers.png",
    "統一獅": "Cpbl-stats-uni-president-7-ele.png",
    "樂天桃猿": "Rakuten_Monkeys_logo.png",
    "富邦悍將": "Fubon_Guardians_logo.svg",
    "味全龍": "Wei_Chuan_Dragons_logo.png",
    "台鋼雄鷹": "台鋼雄鷹.png"
  };

  function logoFile(name) { return TEAM_LOGO[name] || null; }

  // src for an <img>; encodeURIComponent handles spaces/括號/句點/中文檔名
  function logoSrc(name) {
    var f = TEAM_LOGO[name];
    return f ? "./Logo/" + encodeURIComponent(f) : null;
  }

  // 回一個白圓底座包住隊徽的節點；載入失敗自動退回隊名首字
  function logoEl(name, size) {
    size = size || 40;
    var pad = Math.max(2, Math.round(size * 0.09));
    var wrap = document.createElement("span");
    wrap.className = "team-logo";
    wrap.style.cssText =
      "position:relative;display:inline-flex;align-items:center;justify-content:center;flex:0 0 auto;" +
      "border-radius:50%;background:#fff;overflow:hidden;color:#0c0f14;font-weight:600;" +
      "width:" + size + "px;height:" + size + "px;font-size:" + Math.round(size * 0.34) + "px;";
    wrap.textContent = (name || "").slice(0, 1); // fallback initial (covered by img when it loads)
    var src = logoSrc(name);
    if (src) {
      var img = document.createElement("img");
      img.alt = name || "";
      img.loading = "lazy";
      img.style.cssText =
        "position:absolute;inset:" + pad + "px;width:calc(100% - " + (pad * 2) + "px);" +
        "height:calc(100% - " + (pad * 2) + "px);object-fit:contain;";
      img.onerror = function () { this.remove(); }; // 退回首字
      img.src = src;
      wrap.appendChild(img);
    }
    return wrap;
  }

  global.TEAM_LOGO = TEAM_LOGO;
  global.teamLogoFile = logoFile;
  global.teamLogoSrc = logoSrc;
  global.teamLogoEl = logoEl;
})(typeof window !== "undefined" ? window : this);
