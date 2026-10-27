// japanese-holidays（CommonJS、型定義なし）の使う部分だけの型
declare module 'japanese-holidays' {
  const JapaneseHolidays: {
    getHolidaysOf(year: number, furikae?: boolean): { month: number; date: number; name: string }[];
  };
  export default JapaneseHolidays;
}
