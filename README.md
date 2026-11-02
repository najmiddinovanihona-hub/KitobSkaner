# Kitob Skaner

Kamera orqali kitob sahifalarini birin-ketin nusxalab, bitta PDF faylga yig'ib beradi. 500 sahifali kitoblar ham ko'tariladi.

**Ilovani ochish:** https://najmiddinovanihona-hub.github.io/KitobSkaner/

Telefonda ham, kompyuterda ham brauzerda ochiladi, hech narsa o'rnatish shart emas. Ochilganda kameraga ruxsat bering.

## Ishlatish

1. Kitob sahifasini kameraga ko'rsating. Sahifa topilsa, atrofida **yashil ramka** chiqadi.
2. Pastdagi **oq dumaloq tugmani** (kompyuterda **Probel**ni) bosing.
3. Sahifa kesib olinadi, qiyshiqligi to'g'rilanadi va tozalanadi. Tagida tugmalar chiqadi:
   - **✔ Saqlash va keyingi** (Enter): sahifani saqlaydi, siz keyingi sahifani ochasiz.
   - **↺ Qayta olish** (Esc): shu sahifani qaytadan oladi.
   - **⟳ Burish**: sahifani 90° ga buradi.
4. Hamma sahifalar olingach, **🖼 Sahifalar → 📄 PDF yaratish**ni bosing, nom bering va sifatni tanlang.

## PDF sifati

PDF yaratishda sifat tanlanadi va kutiladigan hajm sahifalaringiz bo'yicha hisoblab ko'rsatiladi:

| Sifat | Rasm o'lchami | 500 sahifali kitob (taxminan) |
|---|---|---|
| Yuqori | asl rasmlar | 150–300 MB |
| O'rta | 1400 px | 50–110 MB |
| Past | 1100 px, matn bemalol o'qiladi | 30–65 MB |

100 sahifadan ko'p bo'lsa, standart sifatda «O'rta» tanlanadi. Hajm sahifadagi matn zichligiga bog'liq. «Oq-qora» rejimda olingan sahifalar eng kichik fayl beradi.

## 🗂 Arxiv

PDF yaratilgach, u skanerlangan sahifalari bilan **🗂 Arxiv**ga tushadi, ish ro'yxati esa yangi kitob uchun bo'shaydi. Arxivda har bir PDF uchun quyidagilar mumkin:

- **⬇ Yuklash**: qayta yuklab olish.
- **↗ Ulashish**: Telegram va boshqa ilovalarga yuborish (telefonda).
- **✏ Nom**: nomini o'zgartirish.
- **👁 Sahifalar**: skanerlangan sahifalarni ko'rish.
- **↩ Tahrirga**: sahifalarni qaytadan ish ro'yxatiga olish, masalan yana sahifa qo'shib yangi PDF qilish uchun. Bunda PDF arxivda ham qoladi.
- **🗑**: arxivdan butunlay o'chirish va joyni bo'shatish.

Arxivda telefonda qancha joy band qilingani ko'rsatiladi. Arxiv shu brauzerning o'zida saqlanadi. Brauzer ma'lumotlari tozalansa, arxiv ham o'chadi, shuning uchun muhim PDF'larni yuklab olib qo'ying.

## 📝 Matn bo'limi (OCR)

Yuqoridagi **📝 Matn** tugmasini bosing. Til standart holatda **Avto**: o'zbek lotin, o'zbek kirill va rus matnlari o'zi farqlanadi. Inglizcha kitoblar uchun **English**ni tanlang.

1. Sahifani suratga olib, **Saqlash va keyingi**ni bosing. Sahifadagi matn orqa fonda o'zi o'qib olinadi, siz shu vaqtda keyingi sahifani olishda davom etasiz.
2. **📝 Matnlar** ro'yxatida har bir sahifaning matni va qaysi tilda o'qilgani turadi. Xatolarni o'sha yerning o'zida tuzatish mumkin, o'zgarishlar o'zi saqlanadi. **↻** sahifani hozirgi tilda qaytadan o'qiydi.
3. Tilni o'zgartirsangiz, ilova boshqa tilda o'qilgan sahifalarni yangi tilda qayta o'qishni taklif qiladi.
4. **📄 PDF yaratish** bosilganda **matnli PDF** chiqadi: undagi matnni belgilab nusxa olish va qidirish mumkin. 500 sahifali matnli PDF bir necha soniyada tayyor bo'ladi va 1 MB atrofida chiqadi. **📋 Matnni nusxalash** tugmasi butun matnni nusxalaydi.

Birinchi marta matn o'qilayotganda til ma'lumotlari (bir necha MB) yuklanadi, keyingi safar tezroq ishlaydi. Telefonda bitta sahifani o'qish taxminan 5–20 soniya oladi.

## Katta kitoblar uchun maslahatlar

- Ilova ochiq turganda ekran o'chmaydi, shunda kamera va matn o'qish to'xtab qolmaydi.
- Ilova yopilsa yoki telefon qayta yoqilsa ham saqlangan sahifalar yo'qolmaydi, kelgan joyingizdan davom etasiz.
- PDF yaratilayotganda ilovani yopmang, jarayon ekranda ko'rinib turadi.

## Sozlamalar (yuqori panel)

- **Rangli / Kulrang / Oq-qora**: rasmli kitoblar uchun Rangli, matn uchun Kulrang, eng kichik fayl uchun Oq-qora.
- **Avto** (belgi): sahifa 1,3 soniya qimirlamay tursa, ilova o'zi suratga oladi. Siz faqat varaqlab, Enter bosasiz.
- **🔄 Kamera**: old va orqa kamera orasida almashtiradi.

## Telefonga ilova qilib o'rnatish

Chrome'da sahifani oching, **⋮ → Bosh ekranga qo'shish** ni bosing. Ilova belgisi telefoningiz ekranida paydo bo'ladi.

## Maslahatlar

- Kitobni **qorong'i fonga** (stol, mato) qo'ying. Shunda sahifa chegarasi oson topiladi.
- Yorug'lik yaxshi bo'lsin, kamera sahifaga tepadan qarab tursin.
- Agar sahifa topilmasa (ramka yo'q bo'lsa), ilova butun kadrni oladi.

## Kompyuter versiyasi (Python)

`desktop/` papkasida Windows uchun alohida dastur bor: `desktop/ishga_tushirish.bat` faylini ikki marta bosing.
