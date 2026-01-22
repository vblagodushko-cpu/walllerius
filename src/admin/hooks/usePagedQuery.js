import { useCallback, useState } from "react";
import { getDocs, limit, startAfter } from "firebase/firestore";


export default function usePagedQuery(qFactory, pageSize = 100) {
const [items, setItems] = useState([]);
const [cursor, setCursor] = useState(null);
const [exhausted, setExhausted] = useState(false);
const [loading, setLoading] = useState(false);


const loadFirst = useCallback(async () => {
setLoading(true);
const q = qFactory(limit(pageSize));
const snap = await getDocs(q);
const docs = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
setItems(docs);
setCursor(snap.docs.at(-1) || null);
setExhausted(snap.size < pageSize);
setLoading(false);
}, [qFactory, pageSize]);


const loadMore = useCallback(async () => {
if (exhausted || !cursor || loading) return;
setLoading(true);
const q = qFactory(limit(pageSize), startAfter(cursor));
const snap = await getDocs(q);
const docs = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
setItems((prev) => [...prev, ...docs]);
setCursor(snap.docs.at(-1) || null);
setExhausted(snap.size < pageSize);
setLoading(false);
}, [qFactory, pageSize, cursor, exhausted, loading]);

const reloadFirst = useCallback(async () => {
setLoading(true);
const q = qFactory(limit(pageSize));
const snap = await getDocs(q);
const docs = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
setItems(docs);
setCursor(snap.docs.at(-1) || null);
setExhausted(snap.size < pageSize);
setLoading(false);
}, [qFactory, pageSize]);


return { items, loadFirst, loadMore, reloadFirst, loading, exhausted };
}