# Kitob Skaner

Kamera orqali kitob sahifalarini birin-ketin nusxalab, bitta PDF faylga yig'ib beradi.

**Ilovani ochish:** https://najmiddinovanihona-hub.github.io/KitobSkaner/

Telefonda ham, kompyuterda ham brauzerda ochiladi, hech narsa o'rnatish shart emas. Ochilganda kameraga ruxsat bering.

## Ishlatish

1. Kitob sahifasini kameraga ko'rsating. Sahifa topilsa, atrofida **yashil ramka** chiqadi.
2. Pastdagi **oq dumaloq tugmani** (kompyuterda **Probel**ni) bosing.
3. Sahifa kesib olinadi, qiyshiqligi to'g'rilanadi va tozalanadi. Tagida tugmalar chiqadi:
   - **Keyingi sahifa** (Enter): sahifani saqlaydi, siz keyingi sahifani ochasiz.
   - **Qayta olish** (Esc): shu sahifani qaytadan oladi.
   - **Burish**: sahifani 90° ga buradi.
   - **Tugatish (PDF)**: barcha sahifalarni bitta PDF qilib yuklab beradi.

Sahifalar bittalab saqlanib boradi. PDF faqat **🖼 Sahifalar → 📄 PDF yaratish** bosilganda, siz bergan nom bilan yaratiladi.

## 🗂 Arxiv

PDF yaratilgach, u skanerlangan sahifalari bilan **🗂 Arxiv**ga tushadi, ish ro'yxati esa yangi kitob uchun bo'shaydi. Arxivda har bir PDF uchun quyidagilar mumkin:

- **⬇ Yuklash**: qayta yuklab olish.
- **↗ Ulashish**: Telegram va boshqa ilovalarga yuborish (telefonda).
- **✏ Nom**: nomini o'zgartirish.
- **👁 Sahifalar**: skanerlangan sahifalarni ko'rish.
- **↩ Tahrirga**: sahifalarni qaytadan ish ro'yxatiga olish, masalan yana sahifa qo'shib yangi PDF qilish uchun. Bunda PDF arxivda ham qoladi.
- **🗑**: arxivdan butunlay o'chirish.

Arxiv shu brauzerning o'zida saqlanadi. Brauzer ma'lumotlari tozalansa, arxiv ham o'chadi.

## 📝 Matn bo'limi (OCR)

Yuqoridagi **📝 Matn** tugmasini bosing va kitob tilini tanlang: o'zbek (lotin yoki kirill), rus yoki ingliz.

1. Sahifani suratga olib, **Saqlash va keyingi**ni bosing. Sahifadagi matn orqa fonda o'zi o'qib olinadi, siz shu vaqtda keyingi sahifani olishda davom etasiz.
2. **📝 Matnlar** ro'yxatida har bir sahifaning matni turadi. Xatolarni o'sha yerning o'zida tuzatish mumkin, o'zgarishlar o'zi saqlanadi. **↻** tugmasi sahifani qaytadan o'qiydi.
3. **📄 PDF yaratish** bosilganda **matnli PDF** chiqadi: undagi matnni belgilab nusxa olish va qidirish mumkin. **📋 Matnni nusxalash** tugmasi butun matnni nusxalaydi.

Birinchi marta matn o'qilayotganda til ma'lumotlari (bir necha MB) yuklanadi, keyingi safar tezroq ishlaydi.

## Sozlamalar (yuqori panel)

- **Rangli / Kulrang / Oq-qora**: rasmli kitoblar uchun Rangli, matn uchun Kulrang, eng kichik fayl uchun Oq-qora.
- **Avto**: sahifa 1,3 soniya qimirlamay tursa, ilova o'zi suratga oladi. Siz faqat varaqlab, Enter bosasiz.
- **🔄 Kamera**: old va orqa kamera orasida almashtiradi.

## Telefonga ilova qilib o'rnatish

Chrome'da sahifani oching, **⋮ → Bosh ekranga qo'shish** ni bosing. Ilova belgisi telefoningiz ekranida paydo bo'ladi.

## Maslahatlar

- Kitobni **qorong'i fonga** (stol, mato) qo'ying. Shunda sahifa chegarasi oson topiladi.
- Yorug'lik yaxshi bo'lsin, kamera sahifaga tepadan qarab tursin.
- Agar sahifa topilmasa (ramka yo'q bo'lsa), ilova butun kadrni oladi.

## Kompyuter versiyasi (Python)

`desktop/` papkasida Windows uchun alohida dastur bor: `desktop/ishga_tushirish.bat` faylini ikki marta bosing.
