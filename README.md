# Sistem Pintar Penggantian Guru SMK Taman Medan — PWA

PWA responsif untuk merekod ketidakhadiran guru SMK Taman Medan, dengan app shell cache untuk akses luar talian. Rekod disimpan setempat semasa offline; apabila log masuk, rekod disegerakkan dengan Supabase.

## Jalankan secara setempat

Keperluan: Node.js 18 atau lebih baharu.

```sh
npm start
```

Buka `http://localhost:4173`. Service worker dan pemasangan PWA memerlukan `localhost` atau laman yang dihidangkan melalui HTTPS; membuka `index.html` terus sebagai fail tidak mencukupi.

## Sediakan Supabase

1. Dalam Supabase Dashboard untuk projek sekolah, buka **SQL Editor**, kemudian jalankan `supabase/schema.sql`.
2. Dalam **Project Settings → API**, salin **Project URL** dan **Publishable key** (prefix `sb_publishable_`). Legacy `anon` key juga disokong. Jangan gunakan atau dedahkan `sb_secret_` atau `service_role` key dalam PWA.
3. Isi `supabase-config.js` dengan nilai tadi. Fail konfigurasi sebenar dikecualikan oleh `.gitignore`; `supabase-config.example.js` ialah templat selamat untuk setup baharu.
4. Dalam **Authentication → Users**, jemput akaun staf sekolah. Matikan pendaftaran terbuka (open sign-ups), dan gunakan akaun yang dijemput sahaja.
5. Jalankan semula `npm start`, buka aplikasi dan log masuk dengan akaun tersebut. Rekod guru dan ketidakhadiran akan disimpan di pangkalan data.

Polisi RLS dalam skrip membenarkan pengguna yang berjaya log masuk membaca dan mengurus rekod sekolah. Ini sesuai untuk prototaip dalaman satu sekolah; jemput hanya staf yang dibenarkan. Bagi pengeluaran, tambah peranan dan polisi skop organisasi mengikut keperluan akses sekolah. Jangan masukkan maklumat kesihatan sensitif yang tidak diperlukan dalam ruangan catatan.

Rekod setempat sedia ada akan cuba disegerakkan apabila log masuk. Semasa offline, rekod baharu kekal pada peranti sehingga sambungan Supabase tersedia dan log masuk semula. Import Telegram menerima tarikh/hari, kategori, nama guru dan catatan waktu; semak pratonton sebelum menyimpan. Modul cadangan relief menyemak jadual kelas, ketidakhadiran, tugasan slot sedia ada, beban relief dan opsyen subjek. Cadangan boleh disimpan sebagai `suggested` dan dicetak ke PDF melalui dialog cetak pelayar (“Save as PDF”).

Nama guru ketika sinkronisasi mesti sepadan dengan nama dalam `teachers` (padanan ringkas hanya diterima jika unik). Sistem tidak mencipta rekod guru baharu secara automatik daripada teks Telegram.

## Fail utama

- `index.html`, `styles.css`, `app.js`: antara muka, rekod dan aliran import.
- `telegram-parser.js`: parser mesej harian Telegram dan julat masa.
- `relief-engine.js`: pemilihan calon relief berdasarkan jadual dan skor adil.
- `manifest.webmanifest`, `icons/icon.svg`: metadata pemasangan dan ikon.
- `sw.js`: cache app shell dan fallback navigasi luar talian.
- `server.js`: pelayan fail statik Node.js tanpa dependencies.
- `supabase/schema.sql`: jadual, indeks, fungsi kiraan relief dan polisi RLS.
- `supabase-config.example.js`: templat konfigurasi klien Supabase.

Publishable/anon key digunakan dalam klien pelayar dan bukan rahsia; keselamatan data bergantung pada autentikasi dan polisi RLS. Jangan masukkan Supabase secret key ke dalam frontend atau fail yang diterbitkan kepada pelayar.
