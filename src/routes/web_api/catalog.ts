import { FastifyInstance } from "fastify";
import { getItemCatalog } from "../../lib/catalog";
import { CatalogImages } from "../../lib/catalogImages";
import { object, query, string } from "../schemas";

const routes = async (fastify: FastifyInstance) => {
    let images: CatalogImages | undefined
    const thumbnails = () => images ??= new CatalogImages()
    fastify.get("/", { schema: query() }, async () => {
        const catalog = getItemCatalog()
        const imageData = thumbnails()
        const withRects = <T extends { id: number }>(entries: T[], kind: string) => entries.map(entry => {
            const thumbnail = imageData.rect(kind, entry.id)
            return thumbnail ? { ...entry, thumbnail } : entry
        })
        return { ...catalog, items: withRects(catalog.items, "items"), equipment: withRects(catalog.equipment, "equipment") }
    })
    fastify.get<{ Params: { kind: string, id: string } }>("/thumbnail/:kind/:id", {
        schema: { ...query(), params: object({ kind: string, id: string }, ["kind", "id"]) }
    }, async (request, reply) => {
        if (request.params.kind !== "units" || !/^[1-9]\d{0,8}$/.test(request.params.id)) return reply.code(404).send()
        const image = thumbnails().image("units", Number(request.params.id))
        return image ? reply.type("image/png").header("cache-control", "private, max-age=3600").send(image) : reply.code(404).send()
    })
    fastify.get("/sheet", { schema: query() }, async (_request, reply) => {
        const image = thumbnails().image("sheet")
        return image ? reply.type("image/png").header("cache-control", "private, max-age=3600").send(image) : reply.code(404).send()
    })
}
export default routes;
