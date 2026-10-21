// A module whose mount throws: the app must not notice.
export default {
  id: "boom",
  hostApi: 1,
  mount: {
    "sidebar-footer"() {
      throw new Error("boom");
    },
  },
};
