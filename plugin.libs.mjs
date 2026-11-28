// 本插件参与内联的库清单——build 与 validate 共用这一份。
// 顺序即内联顺序：feedback 在 feedback-ui 之前。
// 来源不用写：先按共用包的 exports 解析，解析不到再读 src/lib/<name>.mjs。
export default ["feedback", "feedback-net", "feedback-ui"];
