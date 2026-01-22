# Project ROZA

Система управління замовленнями та товарами для оптової торгівлі.

## Технології

- **Frontend:** React + Vite (MPA)
- **Backend:** Firebase (Firestore + Auth + Cloud Functions + Scheduler)
- **Регіон:** europe-central2
- **Project ID:** embryo-project

## Структура проєкту

- `src/` - Frontend код (React компоненти)
- `functions/` - Cloud Functions (Backend)
- `public/` - Статичні файли
- `dist/` - Збірка для production (генерується автоматично)

## Команди

```bash
# Розробка
npm run dev

# Збірка
npm run build

# Деплой
firebase deploy --only hosting
firebase deploy --only functions
```

## Ліцензія

Private project

