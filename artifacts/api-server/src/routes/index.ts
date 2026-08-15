import { Router, type IRouter } from "express";
import aiRouter from "./ai";
import healthRouter from "./health";

const router: IRouter = Router();

router.use(healthRouter);
router.use(aiRouter);

export default router;
