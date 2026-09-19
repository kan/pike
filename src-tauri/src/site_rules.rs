//! ブラウザのタブのドメインごとの差し込み（#368 の段階 3）。利用者が設定に書いた JS と CSS を、
//! 対象のドメインのページに入れるスクリプトを組み立てる。
//!
//! **組み立てを Rust に置くのは、文字列の埋め込み（エスケープ）を 1 か所にまとめるため。**
//! ドメインの一覧・CSS・ルールの名前は `serde_json` で JS の文字列リテラルにしてから埋める。
//! 利用者の JS だけは素のまま入れる（それが目的）。
//!
//! - **JS はルールごとに別のスクリプトにする。** 利用者の JS に構文エラーがあっても、壊れるのは
//!   そのルールのスクリプトだけで、他のルールには及ばない（1 本に束ねると、1 つの構文エラーで
//!   全部が動かなくなる）。実行時のエラーは `try` でそのルールの中に閉じる
//! - **ドメインの判定はページの中でする。** 差し込みは子 webview を作った時点で固定され、
//!   そのあとのすべての移動で走るので、タブが別のサイトへ移っても効かないように包む
//! - 差し込み先はメインフレームだけ（`initialization_script`）。ルールは「そのドメインの
//!   ページ」に対するもので、埋め込まれた他所の iframe にまで入れる理由が無い

use serde::Deserialize;

/// フロントが渡す 1 ルール（有効なものだけが来る）。
#[derive(Debug, Clone, Deserialize)]
pub struct SiteRule {
    pub id: String,
    pub name: String,
    /// `example.com`（そのホストだけ）か `*.example.com`（サブドメイン。`example.com` 自身は
    /// 含まない）。
    pub domains: Vec<String>,
    pub js: String,
    pub css: String,
}

/// ホスト名がドメインの一覧に一致するか（JS の関数式）。**`hostname` で比べる**（ポートを見ない）。
const HOST_MATCH_JS: &str = "function(h,ps){h=String(h).toLowerCase();\
return ps.some(function(p){p=String(p).toLowerCase();\
return p.indexOf('*.')===0?(h.length>p.length-1&&h.slice(-(p.length-1))===p.slice(1)):h===p;});}";

/// JS の文字列リテラル（か配列）にする。`serde_json` の出力は JS の式としてそのまま読める。
fn js_literal<T: serde::Serialize + ?Sized>(v: &T) -> String {
    serde_json::to_string(v).unwrap_or_else(|_| "null".into())
}

/// 1 ルールの JS を差し込むスクリプト。JS が空なら `None`。
pub fn js_script(rule: &SiteRule) -> Option<String> {
    if rule.js.trim().is_empty() {
        return None;
    }
    Some(format!(
        "(function(){{if(!({HOST_MATCH_JS})(location.hostname,{domains}))return;\n\
         try{{\n{js}\n}}catch(e){{console.error('[Pike] site rule '+{name}+':',e);}}}})();",
        domains = js_literal(&rule.domains),
        js = rule.js,
        name = js_literal(&rule.name),
    ))
}

/// 一致するルールの CSS を当てるスクリプト（ページの読み込みの開始時と、ルールを変えたとき）。
///
/// **前に当てたものは消してから当て直す**（`data-pike-site-css` の印で見分ける）。ルールを
/// 変えたときにも同じスクリプトを流すので、外したルールの CSS が残らない。`<head>` がまだ
/// 無い時点（読み込みの開始時）でも `documentElement` には足せる。
pub fn css_script(rules: &[SiteRule]) -> String {
    let items: Vec<(&str, &[String], &str)> = rules
        .iter()
        .filter(|r| !r.css.trim().is_empty())
        .map(|r| (r.id.as_str(), r.domains.as_slice(), r.css.as_str()))
        .collect();
    format!(
        "(function(){{var m={HOST_MATCH_JS};var rules={rules};\
         function apply(){{var root=document.head||document.documentElement;if(!root)return false;\
         document.querySelectorAll('style[data-pike-site-css]').forEach(function(s){{s.remove();}});\
         rules.forEach(function(r){{if(!m(location.hostname,r[1]))return;\
         var s=document.createElement('style');s.setAttribute('data-pike-site-css',r[0]);\
         s.textContent=r[2];root.appendChild(s);}});return true;}}\
         if(!apply())document.addEventListener('DOMContentLoaded',apply,{{once:true}});}})();",
        rules = js_literal(&items),
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    fn rule(js: &str, css: &str) -> SiteRule {
        SiteRule {
            id: "r1".into(),
            name: "Jira \"ボード\"".into(),
            domains: vec!["*.atlassian.net".into()],
            js: js.into(),
            css: css.into(),
        }
    }

    #[test]
    fn empty_js_adds_nothing() {
        assert!(js_script(&rule("  ", "")).is_none());
    }

    #[test]
    fn name_and_domains_are_escaped() {
        let s = js_script(&rule("console.log(1)", "")).unwrap();
        assert!(s.contains(r#"["*.atlassian.net"]"#));
        assert!(s.contains(r#""Jira \"ボード\"""#));
        assert!(s.contains("\nconsole.log(1)\n"));
    }

    #[test]
    fn css_is_a_string_literal() {
        // CSS に `</style>` や引用符があっても、JS の文字列の外へ出ない。
        let s = css_script(&[rule("", "a::after{content:\"'\"}</style>")]);
        assert!(s.contains(r#"a::after{content:\"'\"}</style>"#));
        assert!(!css_script(&[rule("", " ")]).contains("r1"));
    }
}
