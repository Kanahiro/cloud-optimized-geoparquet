# COGP仕様・Parquet内部設計の修正計画

ステータス: 0.2.0のmetadata・Level/LoD規則をwriter、Rust/JavaScript reader、validatorに反映済み。空間検索はprimary geometryのbboxで地物を選ぶ契約を採用し、相互運用テストを追加した。

## 今回の実装範囲

- 実施済み: 同一row group境界での精細化、共有LoDの有効範囲、0.2の明示的な対応version検査、producerの0.2.0出力。
- 実施済み: validatorでのLoD null範囲検査。座標全体ではなく、LoDごとに必須のtopology leafを読み親structのnull状態を確認する。
- 実施済み: primary bboxによる選択の契約テスト、Rust生成ファイルをJavaScriptで読むテスト、CIでのJavaScript reader・デモテスト実行。
- 未実施: §4のGeoParquetメタデータ保存・スキーマ修正、§5の全geometry内容・統計のデータ検査、§6の性能再測定と設定調整。既存レビューのこれらの作業は引き続き別段階として残す。

## 目的

地物の追加と形状の精細化を独立して扱えるようにし、空間検索の対象を明確にし、GeoParquetとしての意味を保持する。既存のrow group、列投影、PageIndexを使う構造は維持する。

現状の未コミット変更を作業開始点とし、既存の変更を巻き戻さない。単一ファイル、地物行の非重複、lossless primary WKB、描画専用overviewという基本契約は維持する。

## 1. 再現ケースと仕様の契約を先に揃える

レビューで確認したケースを、小さな入力から生成できる回帰fixtureにする。

- 線1本に解像度 `8,1` を指定すると、現在は細かいLoDが消える。
- 空間検索がprimary bboxに従うことを確認する。overviewだけが領域に入っても、その地物は選択しない。これは不具合の再現ではなく、合意した検索契約の確認とする。
- `crs: null` が省略される。`edges`などのメタデータが変換で失われる。CRS不明とspherical edgesの検証には別々の適切な入力を使う。
- OPTIONALなprimary geometryに対してREQUIREDなbboxが出力され、validatorも成功する。
- 異なるprefixから同じLoDを参照すると、現在のnull規則を同時に満たせない。

関連箇所: `SPEC.md`、`cogp-rs/tests/`、`cogp-js/test/`。

完了条件: それぞれについて入力、期待する出力・取得結果、現在の失敗理由が明確になる。テストはwriterの実装をなぞらず、ファイルの契約と観測できる結果を検証する。

## 2. LevelとLoDの仕様を修正する

### 採用する案

- `resolution`は引き続き正の有限値で、厳密に減少する。
- `row_group_end`は非減少とする。同じprefixに対して、異なる解像度・LoDを宣言できる。
- 最初の境界は有効なrow groupを指し、最後の境界は引き続きファイル全体を覆う。同じ境界を持つ後続レベルは新しい行を追加しない。
- Line/Polygonでは、地物を追加しないことだけを理由に要求された解像度を削除しない。最初の地物が登場する前の空prefixは作らない。
- Pointでは形状の精細化がないため、新しい地物を追加しない候補の省略を引き続き許す。
- LoDの有効範囲は、そのLoDを参照する全レベルの最大`row_group_end`で一意に定める。その範囲内はnon-null、後ろはnullとする。
- 参照されないLoDは禁止し、LoD名は`geometry_type`などの固定フィールド名と衝突させない。
- 同じLoDを共有する場合の量子化・簡略化方針は、参照する最も細かい解像度に基づく。writerの自動LoD共有は今回の必須変更にしない。

writer内部では、元の候補解像度、各行が登場する候補、物理row group境界の対応を明示する。「空の候補を削除した配列番号」を全用途で共用しない。物理row groupを追加せずにLoDだけを増やせるようにする。

Rust readerのレベル別範囲APIでは、追加行がないレベルは空の範囲を返し、prefix選択は既存の行を返す。JavaScriptのメタデータ検査と両言語のvalidatorも同じ境界規則に合わせる。

### 互換性

同一境界を拒否する旧readerとの互換性はない。既存バージョン番号のまま出力形式を変更しない。

SPEC.mdと実装はドラフト`0.2.0`に統一した。§6.1は1.0未満のminor間で互換性を保証しない規則に改め、readerが対応するmajor/minorを明示的に検査することを定めた。1.0以降のminorは互換変更に限定する。既存公開版とfixtureの対応を確認して反映する。

旧`0.2`ファイルの読取りは明示的に残す。未知の0.xをmajorが0という理由だけで受け入れない。writerは新形式のみ出力し、旧形式のwriter分岐は増やさない。

完了条件: 線1本でも細かいLoDが残る。同一prefixのズーム変更、同じLoDの共有、最後のprefixが全行を覆うことをRustとJavaScriptで検証できる。

## 3. primary bboxによる地物選択を明記する

空間検索はprimary geometryのGeoParquet covering bboxに対して行う。選択された地物の指定LoDのoverviewを描画する。

1. 指定された検索範囲とprimary bboxの統計からrow group・pageの候補を絞る。
2. 各行のprimary bboxと検索範囲を比較し、地物を選択する。
3. 選択した地物のoverviewを取得・復号し、描画する。

readerはこの意味を保ったまま取得と評価の順序を最適化できる。overview自身のbboxは地物選択の条件にしない。描画時のクリッピングは検索とは別の処理とする。

bboxの交差判定は、primary geometryそのものとの厳密な交差判定とは区別する。Rustの候補抽出APIは、行単位の最終bboxフィルタを行うかどうかを契約に明記する。

以前のpadding提案と「overviewが画面内なのに取得されないため不具合」という指摘は撤回する。`bbox_padding`、描画用bbox列、検索範囲の拡張、旧ファイルでpruningを無効化する分岐は追加しない。既存のbboxとPageIndexを利用する。

関連箇所: `SPEC.md` §5.5・§7.2、Rust/JavaScript readerのドキュメントと契約テスト。

完了条件: bbox検索の結果ID集合が「選択prefixの全行をprimary bboxで絞った結果」と一致し、LoDを変えても同一prefix内の選択ID集合が変わらない。overviewだけが領域内のケース、primary bboxだけが領域と交差するケース、PageIndexあり・なしを含める。

## 4. GeoParquetの意味と物理スキーマを保存する

- GeoParquetメタデータは元のJSONを保存し、COGP変換が変更するprimaryのcovering/bboxなどだけ更新する。型付きの参照が必要でも、外部メタデータ全体を不完全な型から再構築しない。
- CRSの省略、明示的null、オブジェクトを区別する。`edges`、`orientation`、`epoch`、未知フィールド、secondary geometryの宣言を保持する。
- 他のfile/schema/field metadataも棚卸しする。行順変更やschema変更で無効になる項目は再生成または明示的に扱い、古い`ARROW:schema`をそのまま複写しない。
- overviewの復号座標はprimaryと同じCRS・XY順・単位であることを仕様に明記する。現行の平面簡略化で扱えないspherical edges等は、黙って意味を変換せずproducerの対応範囲として明示的に拒否する。単位の自動推定も、根拠なくCRS不明をdegreesとみなさない。
- primary geometryとbboxのrepetitionを揃える。null行は禁止したまま、OPTIONALなschemaで実データがすべてnon-nullの入力は扱えるようにする。
- 入力の通常属性`bbox`や`overviews`を予約列として無条件に削除しない。既存covering・既存COGP列との区別をつけ、保存できない衝突は出力前に明示する。
- primaryのWKB要件とGeoParquet 1.1が許す次元を照合する。M/ZMなど、基底仕様の範囲を超えるものを適合扱いにしない。

完了条件: 安定したIDで照合したprimary WKBと属性が完全一致する。保持対象メタデータの意味が変わらず、Parquetスキーマを直接検査してrepetitionの一致を確認できる。非対応入力は理由付きで失敗する。

## 5. validatorの検証範囲を明確にして実装する

同じ仕様規則をreaderとvalidatorで別々に増殖させない。各言語内でメタデータの基本契約を共有し、全データを読む検査はvalidator側に置く。

### 構造検査

version、境界、LoD参照、scale/offset、物理スキーマ、primary/bboxの型とrepetition、必要な統計、GeoParquetメタデータを検査する。出力は「構造検査成功」であり、全要件への適合とは表示しない。

### データ検査

バッチ単位で全行を走査し、primaryのnull/empty・型、bboxの妥当性と包含、LoDの有効範囲とnull、geometry_type、座標とend配列の境界・全要素の消費、定義したリング構造を検査する。プルーニングに使う統計が実データに対して保守的であることも確認する。

自己交差等の全般的な位相保証は新たに追加せず、仕様が要求する符号化上の構造と区別する。地物の視覚的重要度、元入力との同一性など、出力単体で証明できないことは検証結果に含めない。

CLIの通常の`validate`はデータ検査まで行い、明示的な`--metadata-only`で構造検査だけを選べる案とする。結果には実施した検証範囲を表示する。

完了条件: 必須LoDのnull、範囲外のnon-null、誤ったend配列・型・repetition・統計をそれぞれ独立したfixtureで拒否する。正常ファイルは両検査に通る。

## 6. Parquetのコストとズーム時の読取りを検証する

### 維持する設計

`list<struct<x,y>>`、整数のDELTA_BINARY_PACKED、bbox ColumnIndexと投影列OffsetIndex、空間的なページ配置、primary WKBを巻き込まないrange coalescingを維持する。独自の空間インデックスや別ファイルは追加しない。

### 説明とキャッシュ契約

- Arrowの共有offset bufferと、Parquetのleafごとのdefinition/repetition levelsを区別して仕様を説明する。列間のページ対応は同じページ番号ではなく行範囲で扱う。
- Pointのズームでは追加行を取得する。Line/Polygonでは既存行の新LoD列も取得する。属性等の再利用と、描画形状の更新を分けて説明する。
- デモのキャッシュキー・更新経路がLoDを区別し、同じprefixへのズームでも形状を更新できることを確認する。
- コールドアクセスのfooter取得も初期描画コストに含める。非COGP readerについて、行順だけで描画用overviewの転送削減まで得られるような説明は修正する。

### 測定と採否

LoD数L・row group数Gに対してoverviewだけで約`4LG`個のcolumn chunkを持つことを明記する。nullの値は圧縮できても、schema・chunk metadata・ページ等の費用がなくなるわけではない。

同じ入力、投影、viewport、キャッシュ条件で次を測る。

- 全体サイズ、footer bytes、PageIndex bytes、LoD別payload、辞書bytes。
- コールド初期取得と、同じprefixでLoDだけ変えるズームの転送量・request数・時間。
- Point、細かい地物を含むLine/Polygon、大きな地物だけのLine/Polygon。
- geometryのみ、ID込み、実際に利用する属性込みの投影。
- primary bboxの候補数と、pruningなしに対する取得量。

既存ベンチマークの過去のwriter設定は現在と一致するとは限らないため、比較用baselineを再計測する。全データの組合せ総当たりはせず、小さい代表セットで絞ってから大きなデータで確認する。

辞書上限やrow group/pageサイズのデフォルト変更は測定後に決める。LoD数増加への対応として自動重複排除や新しい設定項目を先に追加しない。性能基準は変更前の実測値から定め、正確性を満たしたうえで、footer増加・検索量削減・初期表示時間のトレードオフを記録する。

完了条件: primary bboxで選択した地物の取得漏れがなく、取得範囲が選択した列・LoDに対応することを確認できる。新しいLoD保持の性能コストが測定され、採用するデフォルトの根拠が残る。

## 7. 統合と完了判定

変更は次のまとまりで進め、各段階で必要なテストを通す。

1. 仕様・version方針・共通fixture。
2. GeoParquetメタデータ保存と物理スキーマ修正。
3. Level/LoDのwriter、Rust/JavaScript readerの変更。
4. primary bboxによる検索契約の文書化と検証。
5. validatorと相互運用テスト。
6. デモ・ドキュメント・性能測定、必要と判断した調整。

最終確認では`cargo test --workspace --all-features`、Rust lint、JavaScript readerテスト、デモのテスト、typecheck/buildを実行する。Rustで生成したfixtureをJavaScriptで読み、ID・選択LoD・復号座標・bbox検索結果を照合する。WKB保存とGeoParquet互換性はCOGP reader以外でも確認する。

レビューの全指摘について、対応箇所、検証結果、性能上の残る制約を記録する。公開データの置換、パッケージリリース、デモのデプロイはこの実装計画の完了条件に含めない。

## 指摘との対応

| 指摘 | 対応段階 |
| --- | --- |
| 新規地物がない解像度のLoD消失 | 1、2 |
| overviewのboundsと検索対象の混同（不具合指摘を撤回） | 1、3でprimary bboxによる選択契約を明記 |
| GeoParquetメタデータの意味の消失 | 1、4 |
| geometry/bboxのrepetition不一致 | 1、4、5 |
| 共有LoDのnull規則の矛盾 | 2、5 |
| validatorの過大な適合表明 | 5 |
| PageIndexによる部分取得の維持 | 3、6 |
| ArrowとParquetの物理構造の説明混同 | 6 |
| footer・辞書・疎なLoDのコスト | 6 |
| ズーム時の追加取得に関する誤説明 | 2、6 |
