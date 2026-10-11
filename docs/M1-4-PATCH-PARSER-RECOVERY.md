# M1.4 — Khôi phục bộ phân tích patch trên Windows

Ngày: 2026-10-11 (UTC). Nhánh: `arena/a1c939c5-aurelia`.

Ký hiệu: **PASS** · **FAIL** · **BLOCKED** (không chạy được ở đây, nêu rõ lý do) ·
**NOT TESTED** (chưa thử).

Tài liệu này ghi lại nguyên nhân gốc, bản sửa và bằng chứng của sự cố
`0001-aurelia-webui-and-resources.patch` không phân tích được trên Windows.
Không có tuyên bố nào ở đây nói rằng Chromium đã biên dịch thành công.

## 1. Sự cố

Run [`38108794402`](https://github.com/ankworks/aurelia/actions/runs/38108794402)
(`gn / standard`, `windows-2025`) thất bại sau khi đồng bộ Chromium 155 thành
công, tại stage `patch-verification`:

```
unexpected content before first file header:
"diff --git a/chrome/browser/BUILD.gn b/chrome/browser/BUILD.gn\r"
```

Các bước trước đó đều PASS: Windows SDK 10.0.28000.0, Visual Studio 2026, đồng bộ
đúng revision đã pin. Tiêu thụ đĩa 29,5 GB.

## 2. Nguyên nhân gốc

Chuỗi nhân quả, mỗi mắt xích đều kiểm chứng được:

1. **Git for Windows trên runner Windows mặc định `core.autocrlf=true`.** Ảnh
   `actions/runner-images` cài Git for Windows bằng `Install-Git.ps1` với
   `/VERYSILENT`, `/o:PathOption=CmdTools`, `/COMPONENTS=gitlfs` — **không** có
   `/o:AutoCRLF=false`. Mặc định của bộ cài Git for Windows là "Checkout
   Windows-style, commit Unix-style line endings", tức `core.autocrlf=true`
   trong gitconfig cấp **system**.
2. **Repository không có `.gitattributes`.** Ở revision `d7866c8` không có tệp
   `.gitattributes` nào, nên không có quy tắc nào ghi đè `core.autocrlf`.
   `git ls-files --eol` trên Linux báo `i/lf w/lf attr/` — cột `attr/` rỗng,
   đúng như dự đoán: git hoàn toàn tự do chuyển đổi khi checkout.
3. **`actions/checkout` không tự tắt chuyển đổi.** Trong mã nguồn của action
   không có tham chiếu nào tới `autocrlf` (đã kiểm tra bằng GitHub code search
   trên `actions/checkout`), nên cấu hình của máy quyết định kết quả.
4. **Kết quả:** bản checkout của
   `chromium/patches/0001-aurelia-webui-and-resources.patch` có CRLF, trong khi
   blob trong git là LF.

`.editorconfig` đã ghi `end_of_line = lf` và có mục `[*.patch]`, nhưng
EditorConfig là quy ước cho editor — git không đọc nó khi checkout. Thiếu đúng
phần có hiệu lực.

## 3. Bộ phân tích patch chịu trách nhiệm

| Thành phần    | Định danh                                                                                 |
| ------------- | ----------------------------------------------------------------------------------------- |
| Hàm           | `parsePatch()` trong `tools/chromium/lib/patch.mjs`                                       |
| Biểu thức lỗi | `FILE_HEADER_RE = /^diff --git a\/(.+) b\/(.+)$/`                                         |
| Nơi gọi       | `verifyOffline()` trong `tools/chromium/verify-patches.mjs`                               |
| Stage         | `patch-verification` của `tools/chromium/ci-validation.mjs` (`verify-patches --checkout`) |

Vì sao một ký tự `\r` phá vỡ cả phép phân tích:

- `\r` **là** LineTerminator theo đặc tả ECMAScript, nên `.` không bao giờ khớp
  nó;
- `$` không có cờ `/m` chỉ khớp ở cuối chuỗi đầu vào;
- do đó `^diff --git a/(.+) b/(.+)$` **không thể** khớp một dòng kết thúc bằng
  CR, dù nội dung còn lại hoàn toàn hợp lệ;
- dòng đó rơi vào nhánh "chưa có file header nào", và vì `String.prototype.trim()`
  loại bỏ `\r`, nó vẫn bị coi là "nội dung lạ" → thông báo sai vị trí
  (`unexpected content before first file header`) thay vì nói về line ending.

Cùng lúc đó kiểm tra digest cũng sẽ thất bại, vì digest được tính trên byte thô
của tệp: bản checkout CRLF **không còn là** artefact đã được review. Đây không
phải lỗi hiển thị.

## 4. Tái hiện cục bộ

Trên Linux, lấy đúng tệp patch đã commit và chuyển sang CRLF cho ra **đúng từng
byte** thông báo lỗi của run:

| Biến thể           | Kết quả                                                                     |
| ------------------ | --------------------------------------------------------------------------- |
| LF (như đã commit) | parse OK, 8 file                                                            |
| CRLF               | `unexpected content before first file header: "... BUILD.gn\r"` — trùng lỗi |
| UTF-8 BOM + LF     | cùng thông báo, kèm BOM vô hình                                             |
| UTF-8 BOM + CRLF   | cùng thông báo                                                              |

Giả lập checkout kiểu Windows (`git -c core.autocrlf=true clone`) trên một
repository nhỏ không có `.gitattributes` cũng cho ra CRLF — đó là "đối chứng" âm
trong bộ test.

## 5. Bản sửa

### 5.1 `.gitattributes` (bản sửa chính)

```gitattributes
* text=auto eol=lf

*.patch -text
*.diff -text
```

- `* text=auto eol=lf`: mọi tệp văn bản luôn ra working tree với LF, bất kể
  `core.autocrlf` trên máy nào.
- `*.patch -text`: tệp patch **không bao giờ** bị chuyển đổi, cả khi checkout lẫn
  khi `git add`. Quy tắc khớp sau thắng, nên `-text` ghi đè dòng `*`.
- Đây là cách Chromium tự bảo vệ cây nguồn của mình (`*.gn text eol=lf`,
  `*.cc text eol=lf`, … trong `.gitattributes` của upstream).

### 5.2 Phân tích lỗi rõ nguyên nhân, không "sửa" dữ liệu

- `PatchEncodingError` (kế thừa `PatchParseError`) nêu đúng CRLF/BOM, số dòng,
  dòng đầu tiên và cách khắc phục; `parsePatch()` vẫn **từ chối** các byte đó.
  Không có việc âm thầm chuẩn hoá `\r\n` → `\n`: patch bị biến dạng phải fail
  closed.
- `verifyOffline()` đọc **byte thô** rồi mới giải mã, và thêm một check riêng
  `stored with canonical LF bytes` chạy **trước** khi parse. Digest vẫn là
  SHA-256 trên byte thô.
- Các check không phụ thuộc parse (digest, `baseRevision`, định dạng digest) nay
  vẫn chạy dù parse thất bại, nên một bản checkout hỏng báo **cả** "byte không
  chuẩn" **và** "digest lệch" — đúng như bằng chứng, không bớt đi.

### 5.3 Kiểm tra hồi quy và phòng ngừa

| Thành phần                          | Vai trò                                                                                   |
| ----------------------------------- | ----------------------------------------------------------------------------------------- |
| `tools/ci/check-line-endings.mjs`   | Hỏi `git check-attr` xem thuộc tính hiệu lực có bảo đảm LF không; wired vào `fast-checks` |
| `tests/tools/line-endings.test.mjs` | Test đơn vị + **giả lập checkout Windows thật** bằng `git clone -c core.autocrlf=true`    |
| `tests/tools/patch.test.mjs`        | CRLF/BOM bị từ chối kèm `PatchEncodingError`                                              |
| `verify-patches --online`           | Ghim `core.autocrlf=false` cho repo tạm, như `generate-patch.mjs` đã làm                  |

Vì sao cần một check riêng cho line ending: CI nhanh chạy trên Linux, nơi **lỗi
này vô hình**. Không có check đó thì `.gitattributes` có thể bị xoá hoặc thu hẹp
mà không ai biết cho tới khi một run Windows tốn 18 phút lại thất bại.

## 6. Những gì không thay đổi

- Revision Chromium đã pin: `cfaadc5a132d78e1828635aa8405a499f3e14864`
  (155.0.8059.40) — không đổi.
- Tệp patch `0001-aurelia-webui-and-resources.patch` — không đổi một byte nào;
  `sha256` vẫn là `7035d77324218e8b81761d277b13112cd290343fe156d7575f4006477187e85d`.
- `chromium/verification/pre-images.json` và mọi digest — không đổi.
- Không nới lỏng kiểm tra: patch sai vẫn fail; không thêm `continue-on-error`,
  không nuốt lỗi, không chuẩn hoá dữ liệu để "cho qua".

## 7. Kết quả kiểm tra

| Kiểm tra                                                    | Kết quả | Bằng chứng                                                                        |
| ----------------------------------------------------------- | ------- | --------------------------------------------------------------------------------- |
| `npm run ci` (format, lint, typecheck, test, build, checks) | PASS    | 442 test / 35 tệp PASS; `FAST CHECKS PASSED`                                      |
| `verify-patches` (offline)                                  | PASS    | 13 check, gồm `stored with canonical LF bytes` và digest khớp                     |
| `verify-patches --online`                                   | PASS    | 8 pre-image khớp digest tại `cfaadc5a132d`, `git apply` sạch, 8 post-image khớp   |
| `check-line-endings.mjs`                                    | PASS    | `git check-attr` báo `text: unset` cho tệp patch                                  |
| Giả lập checkout `core.autocrlf=true`                       | PASS    | Patch trong bản clone giữ LF và khớp `sha256` trong metadata                      |
| CI (fast) trên GitHub                                       | PASS    | run [`38110301219`](https://github.com/ankworks/aurelia/actions/runs/38110301219) |

## 8. Bằng chứng trên runner Windows

Workflow `chromium-build.yml` chỉ chạy bằng `workflow_dispatch` ("Manual only"),
và token của phiên này **không** có quyền dispatch: GitHub trả
`HTTP 403: Resource not accessible by integration` cho
`POST /repos/ankworks/aurelia/actions/workflows/.../dispatches`.

Để vẫn có bằng chứng thật trên `windows-2025`, một trigger `push` **tạm thời**
giới hạn ở nhánh này đã được thêm trong đúng một commit, dùng cho một run duy
nhất, rồi được gỡ ở commit kế tiếp (cách làm trước đây: commit `ed004b508fc4`).
Trigger đó vi phạm bất biến của repository
(`tests/tools/chromium-ci-validation.test.mjs` yêu cầu chỉ `workflow_dispatch`),
nên chính CI nhanh đã báo đỏ ở commit tạm - đúng như thiết kế. Không có phần nào
của trigger này đi vào `main`.

Run: [`38110384256`](https://github.com/ankworks/aurelia/actions/runs/38110384256)
trên Windows Server 2025 (10.0.26100, image `windows-2025-vs2026` 20260925.250.1,
runner 2.337.0, `git version 2.55.0.windows.5`), commit `886ae63`, thời lượng
19m34s.

| Stage / bước                             | Kết quả    | Bằng chứng từ log run                                                                                                                        |
| ---------------------------------------- | ---------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| Preflight + pinned sync (đã PASS trước)  | PASS       | `checkout verified at the pinned revision`; đĩa còn 117,5 GB, đã dùng 29,5 GB                                                                |
| Patch verification (stage từng FAIL)     | **PASS**   | `stored with canonical LF bytes` -> `6642 bytes, no CRLF, no byte-order mark`                                                                |
| Digest patch                             | PASS       | `patch digest matches metadata` -> `7035d77324218e8b... over 6642 byte(s)`                                                                   |
| Parse unified diff                       | PASS       | `parses as a unified diff` -> `8 file(s), +26/-0`                                                                                            |
| Pre-image tại revision đã pin            | PASS       | `8 file(s) verified via git at cfaadc5a132d`                                                                                                 |
| `git apply` lên pre-image                | PASS       | `applies to the pinned pre-images` -> `applied cleanly`                                                                                      |
| Post-image khớp digest                   | PASS       | `8 file(s) byte-identical to the recorded result`                                                                                            |
| Áp dụng overlay + patch vào cây Chromium | PASS       | `overlay: 20 installed, 0 unchanged`; `patches: 1 applied`                                                                                   |
| Fork-delta budget                        | PASS       | `fork delta within budget (<= 10 files, <= 50 added lines)`                                                                                  |
| GN argument policy                       | PASS       | `PASS config\gn\win-x64-dev.gn: 6 reviewed argument(s)`                                                                                      |
| `gn gen` (tạo build graph)               | **FAIL**   | `python3_bin_reldir.txt not found. need to initialize depot_tools by running gclient or update_depot_tools` -> `FAIL: gn exited with code 1` |
| `gn check`                               | NOT TESTED | không chạy tới                                                                                                                               |

### 8.1 Blocker mới lộ ra sau khi sửa (không liên quan bộ phân tích patch)

Lỗi CRLF đã được sửa: patch verification và **cả bước áp dụng patch** nay PASS
trên runner thật. Pipeline đi xa hơn trước và dừng ở `gn gen` vì một nguyên nhân
khác hẳn:

- `gn` trên Windows được `cmd.exe` phân giải thành `depot_tools\gn.bat`, và
  wrapper này cần `python3_bin_reldir.txt` do bootstrap của depot_tools tạo ra;
- tệp đó không tồn tại, nên wrapper thoát ngay với mã 1 (0,03 giây sau khi stage
  bắt đầu);
- run này đặt `DEPOT_TOOLS_UPDATE=0` (chính sách pin toolchain, xem
  [CI-SECURITY.md](CI-SECURITY.md)); cần rà soát xem bootstrap python3 của
  depot_tools có bị chặn bởi chính sách đó hay không. Nguyên nhân sâu này **chưa**
  được xác nhận đầy đủ trong phiên này.

Đây là việc của nhánh kế tiếp, không phải của bản sửa này: thay đổi bootstrap
depot_tools là thay đổi toolchain đang được pin, và cần một run Windows riêng để
chứng minh. **Không có kết quả nào ở đây được gọi là GN PASS.**
