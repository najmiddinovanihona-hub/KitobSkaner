# Kitob Skaner

Kamera orqali kitob sahifalarini birin-ketin nusxalab, bitta PDF faylga yig'ib beradi.

## Ishga tushirish

`ishga_tushirish.bat` faylini ikki marta bosing. Kerakli kutubxonalar birinchi marta o'zi o'rnatiladi.

Qo'lda ishga tushirish:

```
pip install -r requirements.txt
python kitob_skaner.py
```

## Ishlatish

1. Kitob sahifasini kameraga ko'rsating. Sahifa topilsa, atrofida **yashil ramka** chiqadi.
2. **Nusxa olish** tugmasini (yoki **Probel**ni) bosing.
3. Sahifa kesib olinadi, qiyshiqligi to'g'rilanadi va tozalanadi. Tagida tugmalar chiqadi:
   - **Keyingi sahifa** (Enter): sahifani saqlaydi, siz keyingi sahifani ochasiz.
   - **Qayta olish** (Esc): shu sahifani qaytadan oladi.
   - **Burish**: sahifani 90° ga buradi.
   - **Tugatish (PDF)**: barcha sahifalarni bitta PDF qilib saqlaydi.

## Sozlamalar (yuqori panel)

- **Rejim**:
  - *Rangli*: rasmli kitoblar uchun.
  - *Kulrang (toza)*: matn uchun, standart rejim.
  - *Oq-qora (skaner)*: eng kichik fayl, eng aniq matn.
- **Avto-olish**: sahifa 1,3 soniya qimirlamay tursa, dastur o'zi suratga oladi. Siz faqat sahifani varaqlab, Enter bosasiz.
- **Kamera**: `0`, `1`, `2` raqamlari kompyuterdagi kameralarni bildiradi. Telefonni kamera qilish uchun Android'ga **IP Webcam** ilovasini o'rnating va uning manzilini kiriting, masalan `http://192.168.1.5:8080/video`. Telefon kamerasi ancha sifatli tasvir beradi.

## Maslahatlar

- Kitobni **qorong'i fonga** (stol, mato) qo'ying. Shunda sahifa chegarasi oson topiladi.
- Yorug'lik yaxshi bo'lsin, kamera sahifaga tepadan qarab tursin.
- Agar sahifa topilmasa (ramka yo'q bo'lsa), dastur butun kadrni oladi.
