/**
 * ============================================================
 * http/routes/profile.ts — 用户画像
 * ============================================================
 *
 * GET /api/profile - 获取用户画像
 * PUT /api/profile - 更新用户画像
 */

import { Router, type Request, type Response } from 'express'
import { userProfileRepo } from '../../db/user-profile.repository'

export const profileRouter: Router = Router()

profileRouter.get('/profile', async (_req: Request, res: Response) => {
  console.debug('[Route] GET /api/profile')
  const profile = await userProfileRepo.getOrCreate()
  res.json(profile)
})

profileRouter.put('/profile', async (req: Request, res: Response) => {
  console.info('[Route] PUT /api/profile')
  const { allergies, diet_type, skill_level, disliked, calorie_goal } = req.body

  const profile = await userProfileRepo.update('default', {
    allergies,
    diet_type,
    skill_level,
    disliked,
    calorie_goal,
  })

  res.json(profile)
})
