/* ============================================================
   隊徽對照表  TEAM_LOGO
   隊名（與 index.html 的 LEAGUES.teams 完全一致）→ Logo/ 內的檔名
   用法：index.html 在主 <script> 之前載入本檔，
        renderCard 用 teamLogoEl(name) / teamLogoSrc(name) 取得隊徽。
   同源部署（GitHub Pages / 本機 http.server）用相對路徑 ./Logo/。
   ============================================================ */
(function (root) {
  var BASE = "Logo/";

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

    /* ---- NPB 日職 (12) ---- */
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

    /* ---- KBO 韓職 (10) ---- */
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

    /* ---- CPBL 中職 (6) ---- */
    "中信兄弟": "Cpbl-stats-chinatrust-brothers.png",
    "統一獅": "Cpbl-stats-uni-president-7-ele.png",
    "樂天桃猿": "Rakuten_Monkeys_logo.png",
    "富邦悍將": "Fubon_Guardians_logo.svg",
    "味全龍": "Wei_Chuan_Dragons_logo.png",
    "台鋼雄鷹": "台鋼雄鷹.png"
  };

  // 結算/匯入用的簡稱也指到同一隊徽（與 index.html 的 TEAM_ALIASES 對齊的常見簡稱）
  var ALIAS = {
    "阪神": "阪神虎", "橫濱": "橫濱DeNA", "廣島": "廣島鯉魚", "養樂多": "養樂多燕子",
    "中日": "中日龍", "軟銀": "軟銀鷹", "火腿": "日本火腿", "樂天金鷲": "樂天金鷲",
    "西武": "西武獅",
    "雙子": "LG雙子", "巫師": "KT巫師", "登陸者": "SSG登陸者", "恐龍": "NC恐龍",
    "華老鷹": "韓華鷹", "培證": "培證英雄",
    "兄弟": "中信兄弟", "統一": "統一獅", "富邦": "富邦悍將", "味全": "味全龍", "台鋼": "台鋼雄鷹"
  };

  function fileFor(name) {
    if (!name) return null;
    if (TEAM_LOGO[name]) return TEAM_LOGO[name];
    if (ALIAS[name] && TEAM_LOGO[ALIAS[name]]) return TEAM_LOGO[ALIAS[name]];
    return null;
  }

  // 完整 URL（同源相對路徑）。檔名直接放進 src 即可，瀏覽器會處理括號/中文。
  function teamLogoSrc(name) {
    var f = fileFor(name);
    return f ? (BASE + f) : null;
  }

  // 回傳一個已設好 class/alt 的 <img>，載入失敗時自動隱藏（露出底下的首字圓底）。
  function teamLogoEl(name) {
    var src = teamLogoSrc(name);
    if (!src) return null;
    var img = document.createElement("img");
    img.className = "tlogo";
    img.alt = name || "";
    img.loading = "lazy";
    img.decoding = "async";
    img.src = src;
    img.onerror = function () { img.style.display = "none"; };
    return img;
  }

  root.TEAM_LOGO = TEAM_LOGO;
  root.teamLogoSrc = teamLogoSrc;
  root.teamLogoEl = teamLogoEl;

  if (typeof module !== "undefined" && module.exports) {
    module.exports = { TEAM_LOGO: TEAM_LOGO, teamLogoSrc: teamLogoSrc, fileFor: fileFor };
  }
})(typeof window !== "undefined" ? window : this);
