export const probe = () => {
    try {
        throw new Error("probing");
    } catch (e) {
        console.error("probed:")
        console.error(e);
    }
}
