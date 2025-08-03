const { getAllUsers } = require("./userDb");

async function main() {
    const res = await getAllUsers();
console.log(res)
}

main()